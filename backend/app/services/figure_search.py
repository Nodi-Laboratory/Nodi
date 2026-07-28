"""교과서 도판 검색 — 스킬과 레거시 경로가 함께 쓰는 단일 구현 (D111).

예전에는 **프론트가** SSE 전에 `POST /retrieve`를 불러 도판을 미리 받아 왔다.
그 설계의 문제는 둘이다:

  1. 인사 한 마디에도 질의 임베딩 + Qdrant 검색이 나갔다(무조건 호출이었다).
  2. 검색 오케스트레이션이 클라이언트에 있었다 — ReAct 스킬이 같은 일을 하게
     되면서 학급 세션에서 **도판 검색이 두 번** 나가는 상태가 됐다.

이 모듈이 단일 구현이 되고, 프론트의 선행 호출과 `/retrieve` 라우터는 사라진다.
호출자는 둘뿐이다:
  - `ai/skills/search_textbook_figure.py` (ReAct 경로 — 모델이 판단해서)
  - `routers/chat.py`의 레거시 분기 (react_enabled=false — 질문마다)

Qdrant는 신뢰 경계가 아니다 — 히트 id로 **USER 스코프 재조회**해 RLS가 학급
접근을 재검증한다. 못 읽는 히트는 조용히 탈락한다(D87 규약 유지).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..config import get_settings
from ..db.client import UserClient
from . import app_settings, figures, qdrant_store, rag, upstage

logger = logging.getLogger("nodi.figure_search")
settings = get_settings()


async def search_class_figures(
    client: UserClient, space_ref: str | None, query: str
) -> list[dict[str, Any]]:
    """학급 교과서 도판 top-K. 어떤 실패든 `[]` — 검색은 채팅을 막지 않는다.

    반환은 `figures.figure_item()` 형태(snake_case) 그대로다 — `/retrieve`
    응답과 같은 모양이라 프론트가 쓰던 변환을 그대로 재사용할 수 있다.
    """
    if not space_ref or not query.strip():
        return []
    try:
        file_ids = await rag.textbook_file_ids(client, space_ref)
        if not file_ids:
            return []

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
            return []

        scores = {h["id"]: h["score"] for h in hits}
        rows = await client.select(
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
            return []

        # D98: 서명은 병렬로 — 학생 질의의 응답 경로라 직렬 왕복이 그대로 지연이다.
        urls = await asyncio.gather(
            *(figures.sign_figure_url(row) for row in ranked), return_exceptions=True
        )
        out: list[dict[str, Any]] = []
        for row, url in zip(ranked, urls, strict=True):
            if isinstance(url, BaseException) or not url:
                continue  # URL 없는 도판은 캔버스에 못 띄운다(D87)
            out.append(figures.figure_item(row, url, scores.get(str(row["id"]))))
        logger.info("도판 검색: %d건", len(out))
        return out
    except Exception:  # noqa: BLE001 - 검색 실패는 빈 목록으로 강등
        logger.exception("도판 검색 실패 — 빈 목록으로 진행")
        return []
