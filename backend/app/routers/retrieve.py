"""POST /retrieve — 개념 캔버스용 질의 임베딩 + EBS/아트 노드 검색 + canvas_cards near.

Upstage embedding-query(4096d)로 질의를 임베딩하고:
  1. Qdrant ebs/art_assets 코사인 검색(전역 카탈로그)
  2. canvas_cards 벡터와 질의 임베딩 코사인 → 힘 솔버 초기 추정 좌표 계산

응답: {near: {x, y, score|null}, ebs[], art[], degraded}
  - near: 항상 존재 (degraded/빈 세션이면 캔버스 중앙 폴백 — 로딩 카드 상시 표시 요구).
  - embedding 필드: 응답에서 제거 (프론트가 더 이상 사용 안 함).

best-effort: 어떤 실패든 200 + degraded=true (클라는 near 폴백 좌표로 배치).
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
    """질의 -> {near, ebs[], art[], degraded}. 항상 200.

    near는 항상 존재한다 — degraded여도 폴백 좌표를 반환하므로
    프론트는 로딩 카드를 항상 표시할 수 있다.
    """
    from ..services.canvas_layout import CANVAS_W, CANVAS_H

    # near: 태그는 답변 전 미지 → 중앙 폴백(첫 place가 태그 앵커로 이동)
    center = {"x": CANVAS_W / 2.0, "y": CANVAS_H / 2.0, "score": None}

    question = body.question.strip()
    if not question:
        # 빈 질문: 폴백 near(캔버스 중앙) + degraded
        return {"near": center, "ebs": [], "art": [], "degraded": True}
    try:
        vec = await upstage.embed_query(question)
        # ebs, art 검색을 병렬 실행(질의 임베딩) — near는 중앙 상수.
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
        return {"near": center, "ebs": [], "art": [], "degraded": True}
    return {
        "near": center,
        "ebs": _ebs_items(ebs_hits),
        "art": _art_items(art_hits),
        "degraded": False,
    }
