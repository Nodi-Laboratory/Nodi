"""POST /retrieve — 개념 캔버스용 질의 임베딩 + EBS/아트/교과서 figure 노드 검색.

Upstage embedding-query(4096d)로 질의를 임베딩해 Qdrant ebs/art_assets를
코사인 검색한다(전역 카탈로그). 학급 세션이면 교과서 figure(textbook_figures)를
학급 스코프로 함께 검색해 signed URL과 함께 반환한다(TASK 4, D87). 카드 배치·
카메라는 프론트 소유(d3-force)이므로 서버는 좌표를 계산·반환하지 않는다.

응답: {ebs[], art[], figures[], degraded}

best-effort: 어떤 실패든 200 + degraded=true (검색은 부가 기능). figure는 자체
try/except 별도 레그 — 그 실패는 figures:[]로만 나타나고 ebs/art·degraded 의미는
불변이다.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..config import get_settings
from ..services import app_settings, figures, qdrant_store, rag, sessions, upstage
from ..services.supabase_client import UserClient

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


async def _search_figures(
    user: CurrentUser, session_id: str, vec: list[float]
) -> list[dict]:
    """학급 교과서 figure 스코프 검색 → signed URL 포함 항목(TASK 4, D87).

    자체 try/except 별도 레그 — 어떤 실패든 [] (ebs/art·degraded 의미 불변).
    Qdrant는 신뢰 경계가 아니므로 히트 id로 USER 스코프 textbook_figures를
    재조회해 RLS(0038)가 학급 접근을 재검증한다(rag.search와 동형: 못 읽는 히트
    조용히 탈락). 질의 임베딩(vec)은 호출부의 1회 계산을 공유(재임베딩 금지).
    """
    try:
        client = UserClient.from_user(user)
        # 세션 행 조회로 space_kind/space_ref 확인(RLS 재검증 — 접근 불가/없으면
        # get_session이 404를 던지고 아래 except가 []로 강등).
        session = await sessions.get_session(client, session_id)
        if session.get("space_kind") != "class":
            return []
        space_ref = session.get("space_ref")
        if not space_ref:
            return []
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
        hits = await qdrant_store.search(
            qdrant_store.COL_TEXTBOOK_FIGURES,
            vec,
            settings.figure_retrieve_top_k,
            file_ids=file_ids,
            # distance = 1 - score 규약 → score_threshold = 1 - max_distance
            # (D62 오버레이 반영).
            score_threshold=1.0 - max_dist,
        )
        if not hits:
            return []
        scores = {h["id"]: h["score"] for h in hits}
        # 히트 id로 USER 스코프 재조회 — RLS가 최종 안전망.
        rows = await client.select(
            "textbook_figures",
            {
                "id": f"in.({','.join(scores)})",
                "select": (
                    "id,file_id,page,caption,alt,candidates,"
                    "selected_index,image_path"
                ),
            },
        )
        by_id = {str(r["id"]): r for r in rows}
        out: list[dict] = []
        for h in hits:  # Qdrant 랭킹 유지; RLS/삭제로 못 읽는 id는 조용히 탈락
            row = by_id.get(h["id"])
            if not row:
                continue
            url = await figures.sign_figure_url(row)
            if not url:  # url 없는 figure 노드 방지(D87)
                continue
            out.append(figures.figure_item(row, url, scores.get(h["id"])))
        return out
    except Exception:  # noqa: BLE001 - figure 레그 실패는 figures:[]로만 강등
        logger.exception("figure 검색 실패 — figures 빈 목록으로 강등")
        return []


@router.post("")
async def retrieve(
    body: RetrieveBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """질의 -> {ebs[], art[], figures[], degraded}. 항상 200 (검색은 부가 기능)."""
    question = body.question.strip()
    if not question:
        return {"ebs": [], "art": [], "figures": [], "degraded": True}
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
        return {"ebs": [], "art": [], "figures": [], "degraded": True}
    # figure는 자체 try/except 별도 레그 — 질의 임베딩(vec) 공유(재임베딩 금지).
    figure_items = await _search_figures(user, body.session_id, vec)
    return {
        "ebs": _ebs_items(ebs_hits),
        "art": _art_items(art_hits),
        "figures": figure_items,
        "degraded": False,
    }
