"""POST /retrieve — 개념 캔버스용 질의 임베딩 + EBS/아트 노드 검색.

Upstage embedding-query(4096d)로 질의를 임베딩해 Qdrant ebs/art_assets를
코사인 검색한다(전역 카탈로그). 카드 배치·카메라는 프론트 소유(d3-force)이므로
서버는 좌표를 계산·반환하지 않는다.

응답: {ebs[], art[], degraded}

best-effort: 어떤 실패든 200 + degraded=true (검색은 부가 기능).
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..config import get_settings
from ..services import qdrant_store, upstage

logger = logging.getLogger("nodi.retrieve")
router = APIRouter(prefix="/retrieve", tags=["retrieve"])
settings = get_settings()


class RetrieveBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    session_id: str  # 신규 필수 — canvas_cards 세션 필터에 사용


def _ebs_items(hits: list[dict]) -> list[dict]:
    out = []
    for h in hits:
        p = h.get("payload") or {}
        vid = p.get("video_id")
        if not vid:
            continue
        out.append(
            {
                "video_id": vid,
                "title": p.get("title") or "",
                "thumb": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "score": h["score"],
            }
        )
    return out


def _art_items(hits: list[dict]) -> list[dict]:
    out = []
    for h in hits:
        p = h.get("payload") or {}
        slug = p.get("slug")
        if not slug:
            continue
        out.append(
            {
                "slug": slug,
                "url": p.get("url") or f"/art/{slug}.svg",
                "title": p.get("title") or "",
                "score": h["score"],
            }
        )
    return out


@router.post("")
async def retrieve(
    body: RetrieveBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """질의 -> {ebs[], art[], degraded}. 항상 200 (검색은 부가 기능)."""
    question = body.question.strip()
    if not question:
        return {"ebs": [], "art": [], "degraded": True}
    try:
        vec = await upstage.embed_query(question)
        # ebs, art 검색을 병렬 실행(질의 임베딩).
        ebs_hits, art_hits = await asyncio.gather(
            qdrant_store.search(
                qdrant_store.COL_EBS,
                vec,
                settings.retrieve_ebs_top_k,
                score_threshold=settings.retrieve_ebs_min_score,
            ),
            qdrant_store.search(
                qdrant_store.COL_ART,
                vec,
                settings.retrieve_art_top_k,
                score_threshold=settings.retrieve_art_min_score,
            ),
        )
    except Exception:  # noqa: BLE001 - 검색은 부가 기능, 절대 클라를 깨지 않는다
        logger.exception("retrieve failed — degraded 응답")
        return {"ebs": [], "art": [], "degraded": True}
    return {
        "ebs": _ebs_items(ebs_hits),
        "art": _art_items(art_hits),
        "degraded": False,
    }
