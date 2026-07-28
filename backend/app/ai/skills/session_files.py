"""세션 업로드 파일 스킬 — 목록 조회와 구간 읽기 (D109 2단계).

기존 `session_context.build_session_file_context`는 **매 턴** 파일 전문을
시스템 프롬프트에 통째로 넣었다. 예산이 15만 자다 — 인사 한 마디에도 그만큼이
입력에 실렸다는 뜻이다.

두 스킬로 쪼갠 이유: 결과가 곧 다음 LLM 호출의 입력이다. 목록(파일명·글자 수)은
싸고, 본문은 비싸다. 모델이 먼저 목록을 보고 필요한 파일만, 필요한 만큼 읽게 한다.
"""

from __future__ import annotations

import logging
from typing import Any

from ..base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("nodi.ai.skill.session_files")

# 한 번에 읽어 줄 수 있는 최대 글자 수. 이보다 크게 요청해도 잘라서 준다 —
# 전문을 통째로 tool_result에 실으면 예전의 "매 턴 15만 자"와 다를 게 없다.
_MAX_READ_CHARS = 6000
_DEFAULT_READ_CHARS = 3000


async def _session_files(ctx: SkillContext) -> list[dict[str, Any]]:
    return await ctx.client.select(
        "files",
        {
            "session_id": f"eq.{ctx.session_id}",
            "kind": "eq.user_upload",
            "status": "eq.indexed",
            "select": "id,name,context_chars,created_at",
            "order": "created_at.asc",
        },
    )


class ListSessionFilesSkill(SkillBase):
    name = "list_session_files"
    description = (
        "학생이 이 대화에 올린 파일 목록을 본다(파일명과 분량만). "
        "학생이 '올린 파일'·'내 자료'·'방금 첨부한 것'을 언급하면 먼저 이걸로 "
        "무엇이 있는지 확인하고, 필요한 파일만 read_session_file로 읽어라."
    )
    parameters = {"type": "object", "properties": {}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        files = await _session_files(ctx)
        if not files:
            return SkillResult(
                ok=True,
                message="이 대화에 올린 파일이 없습니다.",
                data={"files": []},
            )
        items = [
            {
                "file_id": str(f["id"]),
                "name": f.get("name") or "파일",
                "chars": f.get("context_chars") or 0,
            }
            for f in files
        ]
        return SkillResult(
            ok=True,
            message=f"올린 파일 {len(items)}개.",
            data={"files": items},
        )


class ReadSessionFileSkill(SkillBase):
    name = "read_session_file"
    description = (
        "학생이 올린 파일의 내용을 읽는다. 파일이 길면 앞부분부터 잘라 준다 — "
        "이어서 읽으려면 from_char를 옮겨 다시 부른다. "
        "먼저 list_session_files로 file_id를 확인해라."
    )
    parameters = {
        "type": "object",
        "properties": {
            "file_id": {
                "type": "string",
                "description": "list_session_files가 알려 준 file_id",
            },
            "from_char": {
                "type": "integer",
                "description": "읽기 시작할 글자 위치(기본 0)",
            },
        },
        "required": ["file_id"],
    }

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        file_id = str(args.get("file_id") or "").strip()
        if not file_id:
            return SkillResult(
                ok=False, message="file_id가 필요합니다.", error_code="bad_args"
            )
        try:
            start = max(0, int(args.get("from_char") or 0))
        except (TypeError, ValueError):
            start = 0

        # 이 세션의 파일인지 **목록으로 확인**한다. file_id만 믿고 읽으면 모델이
        # 다른 세션의 id를 넣었을 때 RLS 안쪽(같은 소유자)에서 새어 나간다.
        files = await _session_files(ctx)
        target = next((f for f in files if str(f["id"]) == file_id), None)
        if target is None:
            return SkillResult(
                ok=False,
                message="이 대화에 그런 파일이 없습니다. list_session_files로 확인하세요.",
                error_code="not_found",
            )

        chunks = await ctx.client.select(
            "file_chunks",
            {
                "file_id": f"eq.{file_id}",
                "select": "seq,chunk_text",
                "order": "seq.asc",
            },
        )
        full = "".join(c.get("chunk_text") or "" for c in chunks)
        if not full:
            return SkillResult(
                ok=True,
                message="파일 내용이 비어 있습니다.",
                data={"text": "", "eof": True},
            )

        body = full[start : start + _DEFAULT_READ_CHARS]
        end = start + len(body)
        return SkillResult(
            ok=True,
            message=f"'{target.get('name') or '파일'}' {start}~{end}자.",
            data={
                "name": target.get("name") or "파일",
                "text": body,
                "from_char": start,
                "next_char": end,
                "total_chars": len(full),
                "eof": end >= len(full),
            },
        )
