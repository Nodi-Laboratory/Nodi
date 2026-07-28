"""교과서 도판 검색 스킬 (D109).

예전에는 프론트가 SSE **전에** `POST /retrieve`를 무조건 한 번 불렀다. 인사에도
질의 임베딩과 Qdrant 검색이 나갔다는 뜻이다. 이제 모델이 "그림이 있으면 좋겠다"고
판단할 때만 돈다.

검색 자체는 `services/figure_search.py`가 단일 구현이다(D111) — 레거시 경로와
같은 코드를 쓴다. 여기는 스코프 검사와 모델에게 돌려줄 형태만 담당한다.
"""

from __future__ import annotations

import logging
from typing import Any

from ...services import figure_search
from ..base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("nodi.ai.skill.figure")


class SearchTextbookFigureSkill(SkillBase):
    name = "search_textbook_figure"
    description = (
        "선생님이 올린 교과서에서 질문과 관련된 그림·도표·사진을 찾는다. "
        "설명에 그림이 있으면 이해가 쉬워질 때 쓴다. 찾은 도판은 시스템이 "
        "캔버스에 자동으로 띄우므로, 답변 본문에 이미지 링크를 쓰지 마라."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                # 자료 검색과 같은 이유 — 자연어가 키워드보다 잘 찾는다.
                "description": (
                    "학생 질문을 그대로 넣되, 그림을 찾는 것이므로 대상이 "
                    "드러나게 쓴다. 지나치게 짧은 명사구는 피한다."
                ),
            }
        },
        "required": ["query"],
    }

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        query = (args.get("query") or "").strip()
        if not query:
            return SkillResult(
                ok=False, message="검색어가 비어 있습니다.", error_code="bad_args"
            )
        if ctx.space_kind != "class" or not ctx.space_ref:
            # 카탈로그가 막아 주지만, 모델이 이름을 지어 부를 수 있으므로 방어.
            return SkillResult(
                ok=False,
                message="개인 공간에는 교과서 도판이 없습니다.",
                error_code="wrong_scope",
            )

        items = await figure_search.search_class_figures(
            ctx.client, ctx.space_ref, query
        )
        if not items:
            return SkillResult(
                ok=True,
                message="질문과 맞는 교과서 도판을 찾지 못했습니다.",
                data={"figures": []},
            )
        return SkillResult(
            ok=True,
            message=f"교과서에서 도판 {len(items)}개를 찾았습니다.",
            # 모델에는 캡션만 보여 준다 — URL은 길기만 하고 모델이 쓸 일이 없다.
            # 캔버스 배치용 전체 항목은 오케스트레이터가 `figures`에서 꺼내 쓴다.
            data={
                "captions": [i.get("caption") or "" for i in items],
                "figures": items,
            },
        )
