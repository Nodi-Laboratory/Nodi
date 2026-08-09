"""학생이 캔버스에 직접 쓴 글 읽기 (2026-08-09).

## 왜 필요한가

캔버스는 읽기만 하는 화면이 아니다. 학생이 **직접 글을 쓴다**(글 쓰기 도구,
`kind='note'`·`source='user'`). 그런데 그 글은 AI에게 가는 어느 경로에도 없었다:

  · `tree_guide`는 **AI 개념 카드만** 노드로 친다(`_tree_lines`) — 트리 모양을
    지키려면 그게 맞다.
  · `get_concept`도 개념 카드만 본다.
  · 세션 파일 전문(D83)은 **올린 파일**이지 캔버스에 쓴 글이 아니다.

그래서 학생이 "내가 정리한 거 맞아?", "내가 쓴 것도 같이 봐 줘"라고 하면
모델은 **그 글의 존재조차 모른 채** 답했다. 실측 2026-08-09: 로컬 DB에 학생이
쓴 글이 116장 있는데 프롬프트로 가는 경로가 하나도 없었다.

## 왜 프롬프트에 늘 붙이지 않고 스킬인가

학생의 글은 메모다 — 짧은 낙서일 때가 많고, 매 턴 통째로 붙이면 프롬프트만
부푼다(D89가 태그 목록에서 겪은 것과 같은 이유). **가리켜 물을 때만** 필요하니
모델이 부르게 둔다. 대신 카탈로그가 **글이 실제로 있을 때만** 이 도구를
보여 준다 — 없는데 보여 주면 모델이 부르고 빈 결과로 군더더기를 붙인다.
"""

from __future__ import annotations

import logging
from typing import Any

from ..base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("nodi.ai.skill.notes")

#: 돌려줄 글의 최대 장수. 메모가 수십 장인 캔버스도 있다.
_MAX_NOTES = 20
#: 글 한 장의 상한. 학생이 긴 글을 붙여 넣을 수 있다.
_MAX_CHARS = 800


class ReadMyNotesSkill(SkillBase):
    name = "read_my_notes"
    description = (
        "학생이 캔버스에 **직접 쓴 글**을 읽는다. "
        "'내가 쓴 것', '내가 정리한 거', '내 메모'처럼 학생 자신의 글을 가리킬 때, "
        "또는 학생의 정리가 맞는지 봐 달라고 할 때 부른다. "
        "AI가 만든 개념 카드는 여기 없다(그건 get_concept이다)."
    )
    parameters = {"type": "object", "properties": {}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        rows = await ctx.client.select(
            "canvas_items",
            {
                "session_id": f"eq.{ctx.session_id}",
                "kind": "eq.note",
                "select": "id,title,body,seq",
                "order": "seq.asc",
            },
        )
        notes = [
            {
                "title": (r.get("title") or "").strip(),
                "text": (r.get("body") or "").strip()[:_MAX_CHARS],
            }
            for r in rows
            if (r.get("body") or "").strip() or (r.get("title") or "").strip()
        ]
        if not notes:
            return SkillResult(
                ok=True,
                message="학생이 직접 쓴 글이 아직 없습니다.",
                data={"notes": []},
            )
        return SkillResult(
            ok=True,
            message=f"학생이 쓴 글 {len(notes)}장입니다.",
            data={"notes": notes[-_MAX_NOTES:]},
        )
