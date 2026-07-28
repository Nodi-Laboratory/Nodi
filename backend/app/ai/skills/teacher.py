"""교사 전용 스킬 — 학급 자료 현황과 학생 활동 (D109 3단계).

선생님이 학급 세션에서 채팅으로 물어볼 수 있게 한다:
  "내가 뭘 올렸더라?"        → list_class_materials
  "우리 반 애들 요즘 뭘 물어봐?" → summarize_class_questions

권한은 **DB가 강제한다**. 두 스킬 모두 호출자 스코프 UserClient로 조회하고,
`is_class_teacher` RPC로 한 번 더 확인한다 — 카탈로그(1층)가 학생에게 이 스킬을
보여주지 않지만, 모델이 이름을 지어 부를 수 있으므로 실행 시점에도 막는다.
"""

from __future__ import annotations

import logging
from typing import Any

from ..base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("nodi.ai.skill.teacher")

# 질문 요약에 쓸 최근 노드 수. 더 많이 봐도 요약 품질이 오르지 않고 입력만 커진다.
_RECENT_QUESTIONS = 60


async def _assert_teacher(ctx: SkillContext) -> SkillResult | None:
    """교사가 아니면 오류 결과를, 맞으면 None을 돌려준다."""
    if ctx.space_kind != "class" or not ctx.space_ref:
        return SkillResult(
            ok=False,
            message="학급 공간에서만 쓸 수 있습니다.",
            error_code="wrong_scope",
        )
    try:
        ok = await ctx.client.rpc(
            "is_class_teacher", {"p_class_id": ctx.space_ref}
        )
    except Exception:  # noqa: BLE001 - 확인 실패는 거절로 강등
        logger.warning("교사 확인 실패 — 거절", exc_info=True)
        ok = False
    if not ok:
        return SkillResult(
            ok=False,
            message="이 학급의 선생님만 볼 수 있습니다.",
            error_code="forbidden",
        )
    return None


class ListClassMaterialsSkill(SkillBase):
    name = "list_class_materials"
    description = (
        "이 학급에 올린 수업 자료·교과서의 목록과 처리 상태를 본다. "
        "선생님이 '내가 올린 자료', '교과서 처리됐어?'처럼 물을 때 쓴다."
    )
    parameters = {"type": "object", "properties": {}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        denied = await _assert_teacher(ctx)
        if denied:
            return denied

        rows = await ctx.client.select(
            "files",
            {
                "space_kind": "eq.class",
                "space_ref": f"eq.{ctx.space_ref}",
                "kind": "in.(class_material,textbook)",
                "select": "id,name,kind,status,chunk_total,chunk_done,created_at",
                "order": "created_at.desc",
                "limit": "50",
            },
        )
        if not rows:
            return SkillResult(
                ok=True,
                message="이 학급에 올린 자료가 아직 없습니다.",
                data={"materials": []},
            )
        items = [
            {
                "name": r.get("name") or "자료",
                "kind": "교과서" if r.get("kind") == "textbook" else "수업자료",
                "status": r.get("status"),
                "chunks": f"{r.get('chunk_done') or 0}/{r.get('chunk_total') or 0}",
            }
            for r in rows
        ]
        indexed = sum(1 for i in items if i["status"] == "indexed")
        return SkillResult(
            ok=True,
            message=f"자료 {len(items)}건 (검색 가능 {indexed}건).",
            data={"materials": items},
        )


class SummarizeClassQuestionsSkill(SkillBase):
    name = "summarize_class_questions"
    description = (
        "이 학급 학생들이 최근에 무엇을 질문했는지 모아 본다. "
        "선생님이 '애들이 뭘 어려워해?', '요즘 무슨 질문이 많아?'처럼 물을 때 쓴다. "
        "질문 목록을 돌려주므로, 너가 주제별로 묶어 설명해 줘라."
    )
    parameters = {"type": "object", "properties": {}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        denied = await _assert_teacher(ctx)
        if denied:
            return denied

        # 이 학급의 학생 세션 → 그 세션들의 질문. 교사 조회 권한은 RLS가 준다
        # (0023의 teacher 정책 — 학급 세션은 담임이 SELECT 가능).
        sessions = await ctx.client.select(
            "sessions",
            {
                "space_kind": "eq.class",
                "space_ref": f"eq.{ctx.space_ref}",
                "select": "id",
                "order": "updated_at.desc",
                "limit": "100",
            },
        )
        ids = [str(s["id"]) for s in sessions if s.get("id")]
        if not ids:
            return SkillResult(
                ok=True,
                message="아직 학생 대화가 없습니다.",
                data={"questions": []},
            )

        nodes = await ctx.client.select(
            "nodes",
            {
                "session_id": f"in.({','.join(ids)})",
                "select": "question,created_at",
                "order": "created_at.desc",
                "limit": str(_RECENT_QUESTIONS),
            },
        )
        questions = [
            (n.get("question") or "").strip()
            for n in nodes
            if (n.get("question") or "").strip()
        ]
        if not questions:
            return SkillResult(
                ok=True, message="아직 질문이 없습니다.", data={"questions": []}
            )
        return SkillResult(
            ok=True,
            message=f"최근 질문 {len(questions)}건.",
            data={"questions": questions},
        )
