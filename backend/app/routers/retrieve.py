"""POST /retrieve — 개념 캔버스용 질의 임베딩 + EBS/아트 노드 검색 + canvas_cards near.

Upstage embedding-query(4096d)로 질의를 임베딩하고:
  1. Qdrant ebs/art_assets 코사인 검색(전역 카탈로그)
  2. canvas_cards kNN top-1 (owner+session 필터) → 앵커 셀 + 빈 셀 좌표 계산

응답: {near: {x, y, score|null}, ebs[], art[], degraded}
  - near: 항상 존재 (degraded여도 폴백 좌표 계산 — 로딩 카드 상시 표시 요구).
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
from ..services.canvas_layout import (
    build_occupied,
    cell_to_xy,
    fallback_anchor,
    nearest_free_cell,
    xy_to_cell,
)

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


async def _compute_near(
    vec: list[float],
    owner_id: str,
    session_id: str,
) -> dict:
    """canvas_cards kNN + 점유 회피 → near {x, y, score|null}.

    score ≥ canvas_near_min_score → 그 카드 좌표를 앵커로 사용.
    그 외(빈 컬렉션, score 미달, 예외) → 폴백 앵커.
    항상 near를 반환하며 절대 raise하지 않는다.
    """
    try:
        # 기존 카드 kNN top-1과 점유 목록을 병렬 조회
        knn_hits, canvas_cards = await asyncio.gather(
            qdrant_store.search_canvas_cards(
                vec, owner_id=owner_id, session_id=session_id, k=1
            ),
            qdrant_store.scroll_canvas_cards(owner_id=owner_id, session_id=session_id),
        )
    except Exception:  # noqa: BLE001
        logger.warning("canvas_cards 조회 실패 — 폴백 near 반환", exc_info=True)
        x, y = cell_to_xy(0, 0)
        return {"x": x, "y": y, "score": None}

    # 점유 셀 집합 구성
    occupied = build_occupied(canvas_cards)

    # 앵커 결정: score 임계 충족 카드가 있으면 그 좌표, 없으면 폴백
    score_val: float | None = None
    if knn_hits:
        hit = knn_hits[0]
        score = hit.get("score") or 0.0
        if score >= settings.canvas_near_min_score:
            payload = hit.get("payload") or {}
            hx = payload.get("x") or 0
            hy = payload.get("y") or 0
            anchor = xy_to_cell(hx, hy)
            score_val = score
        else:
            anchor = fallback_anchor(canvas_cards)
    else:
        anchor = fallback_anchor(canvas_cards)

    # 앵커 셀에서 빈 셀 탐색
    free_cell = nearest_free_cell(anchor, occupied)
    x, y = cell_to_xy(*free_cell)
    return {"x": x, "y": y, "score": score_val}


@router.post("")
async def retrieve(
    body: RetrieveBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """질의 -> {near, ebs[], art[], degraded}. 항상 200.

    near는 항상 존재한다 — degraded여도 폴백 좌표를 반환하므로
    프론트는 로딩 카드를 항상 표시할 수 있다.
    """
    question = body.question.strip()
    if not question:
        # 빈 질문: 폴백 near + degraded
        x, y = cell_to_xy(0, 0)
        return {
            "near": {"x": x, "y": y, "score": None},
            "ebs": [],
            "art": [],
            "degraded": True,
        }
    try:
        vec = await upstage.embed_query(question)
        # ebs, art, canvas_cards 검색을 병렬 실행
        ebs_hits, art_hits, near = await asyncio.gather(
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
            _compute_near(vec, owner_id=user.id, session_id=body.session_id),
        )
    except Exception:  # noqa: BLE001 - 검색은 부가 기능, 절대 클라를 깨지 않는다
        logger.exception("retrieve failed — degraded 응답")
        x, y = cell_to_xy(0, 0)
        return {
            "near": {"x": x, "y": y, "score": None},
            "ebs": [],
            "art": [],
            "degraded": True,
        }
    return {
        "near": near,
        "ebs": _ebs_items(ebs_hits),
        "art": _art_items(art_hits),
        "degraded": False,
    }
