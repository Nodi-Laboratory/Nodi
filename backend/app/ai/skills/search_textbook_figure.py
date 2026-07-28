"""교과서 도판 검색 스킬 (D109).

기존에는 프론트가 SSE **전에** `POST /retrieve`를 무조건 한 번 불렀다. 인사에도
질의 임베딩과 Qdrant 검색이 나갔다는 뜻이다. 이제 모델이 "그림이 있으면 좋겠다"고
판단할 때만 돈다.

`routers/retrieve.py`의 `_search_figures`와 같은 절차를 따른다:
Qdrant 히트 → **USER 스코프로 Postgres 재조회(RLS 재검증)** → signed URL 발급.
Qdrant는 신뢰 경계가 아니라는 불변식은 스킬에서도 그대로다.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ...config import get_settings
from ...services import app_settings, figures, qdrant_store, rag, upstage
from ..base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("nodi.ai.skill.figure")
settings = get_settings()


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
            return SkillResult(
                ok=False,
                message="개인 공간에는 교과서 도판이 없습니다.",
                error_code="wrong_scope",
            )

        file_ids = await rag.textbook_file_ids(ctx.client, ctx.space_ref)
        if not file_ids:
            return SkillResult(
                ok=True,
                message="이 학급에 올라온 교과서가 아직 없습니다.",
                data={"figures": []},
            )

        overlay = await app_settings.get_overlay()
        max_dist = app_settings.as_float(
            overlay,
            "figure_retrieve_max_distance",
            settings.figure_retrieve_max_distance,
            0.1,
            0.9,
        )
        vec = await upstage.embed_query(query)
        hits = await qdrant_store.search(
            qdrant_store.COL_TEXTBOOK_FIGURES,
            vec,
            settings.figure_retrieve_top_k,
            file_ids=file_ids,
            # 거리 규약 distance = 1 - score.
            score_threshold=1.0 - max_dist,
        )
        if not hits:
            return SkillResult(
                ok=True,
                message="질문과 맞는 도판을 찾지 못했습니다.",
                data={"figures": []},
            )

        scores = {h["id"]: h["score"] for h in hits}
        # Qdrant는 신뢰 경계가 아니다 — 히트 id로 USER 스코프 재조회해 RLS가
        # 학급 접근을 재검증한다. 못 읽는 히트는 조용히 탈락.
        rows = await ctx.client.select(
            "textbook_figures",
            {
                "id": f"in.({','.join(scores)})",
                "select": (
                    "id,file_id,page,caption,alt,candidates,selected_index,image_path"
                ),
            },
        )
        by_id = {str(r["id"]): r for r in rows}
        ranked = [by_id[h["id"]] for h in hits if h["id"] in by_id]
        if not ranked:
            return SkillResult(
                ok=True, message="접근 가능한 도판이 없습니다.", data={"figures": []}
            )

        urls = await asyncio.gather(
            *(figures.sign_figure_url(row) for row in ranked), return_exceptions=True
        )
        items: list[dict[str, Any]] = []
        for row, url in zip(ranked, urls, strict=True):
            if isinstance(url, BaseException) or not url:
                continue  # URL 없는 도판은 캔버스에 못 띄운다(D87)
            items.append(figures.figure_item(row, url, scores.get(str(row["id"]))))

        logger.info("스킬 도판 검색: %d건", len(items))
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
