"""SVG 아트 검색 — 개념에 맞는 Claude 생성 일러스트 검색.

질의를 Upstage embedding-query(4096d)로 임베딩하고 Qdrant art_assets 컬렉션을
코사인 검색한다(기존 gemini-embedding + search_art_assets RPC 대체). 가장 가까운
SVG가 거리 임계(art_match_max_distance) 안이면 반환하고, 질의 임베딩도 함께
돌려줘 프론트가 개념 그룹핑에 재사용한다 — 임베딩 1회로 일러스트+그룹핑.

best-effort: 어떤 실패든 {"art": null, ...}로 응답하고 절대 raise하지 않는다.
응답 계약 유지: distance = 1 - qdrant_score (코사인 거리, 0=동일).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query

from ..auth.deps import CurrentUser, get_current_user
from ..config import get_settings
from ..services import qdrant_store, upstage

logger = logging.getLogger("nodi.art")
router = APIRouter(prefix="/art", tags=["art"])
settings = get_settings()


@router.get("/search")
async def search_art(
    q: str = Query(..., min_length=1, max_length=400),
    k: int = Query(1, ge=1, le=5),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    query = q.strip()
    if not query:
        return {"art": None, "embedding": None}

    try:
        vec = await upstage.embed_query(query)
    except Exception:  # noqa: BLE001 - art is optional, never break the caller
        logger.exception("art query embedding failed")
        return {"art": None, "embedding": None}

    try:
        hits = await qdrant_store.search(qdrant_store.COL_ART, vec, k)
    except Exception:  # noqa: BLE001
        logger.exception("art qdrant search failed")
        # 이미지 없이도 그룹핑은 되도록 임베딩은 그대로 반환.
        return {"art": None, "embedding": vec}

    art = None
    if hits:
        best = hits[0]
        payload = best.get("payload") or {}
        # 코사인 유사도 -> 거리(기존 pgvector 계약과 동일한 의미론 유지).
        dist = 1.0 - float(best["score"])
        if dist <= settings.art_match_max_distance:
            art = {
                "slug": payload.get("slug"),
                "url": payload.get("url"),
                "title": payload.get("title"),
                "tags": payload.get("tags") or [],
                "distance": dist,
            }
    return {"art": art, "embedding": vec}
