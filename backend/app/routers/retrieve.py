"""POST /retrieve — 개념 캔버스용 질의 임베딩 + 교과서 figure 노드 검색.

Upstage embedding-query(4096d)로 질의를 임베딩해, 학급 세션이면 교과서
figure(textbook_figures)를 학급 스코프로 검색해 signed URL과 함께 반환한다
(TASK 4, D87). EBS 영상·SVG 아트 전역 카탈로그 검색은 D94(사용자 결정
2026-07-18)로 제거됨. 카드 배치·카메라는 프론트 소유(d3-force)이므로 서버는
좌표를 계산·반환하지 않는다.

응답: {figures[], degraded}

best-effort: 어떤 실패든 200 (검색은 부가 기능). degraded=true는 질의 임베딩
실패, figure 레그 실패는 figures:[]로만 나타난다.
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
        # Qdrant 랭킹 유지; RLS/삭제로 못 읽는 id는 조용히 탈락.
        ranked = [by_id[h["id"]] for h in hits if h["id"] in by_id]
        if not ranked:
            return []
        # D98: signed URL 발급을 병렬화. 과거에는 히트마다 순차 await이라
        # top_k(기본 3)만큼 Storage 서명 왕복이 직렬로 쌓였고, 이건 학생 질의의
        # 응답 경로다(캔버스에 figure가 뜨기 전 대기). chat.py의 컨텍스트 빌더
        # 병렬화(D66)와 같은 처리.
        # return_exceptions: 한 건의 서명 실패가 나머지 figure까지 죽이지 않게
        # — sign_figure_url은 이미 None을 반환하지만 방어적으로 유지한다.
        urls = await asyncio.gather(
            *(figures.sign_figure_url(row) for row in ranked),
            return_exceptions=True,
        )
        out: list[dict] = []
        for row, url in zip(ranked, urls):
            if isinstance(url, BaseException) or not url:
                continue  # url 없는 figure 노드 방지(D87)
            out.append(figures.figure_item(row, url, scores.get(str(row["id"]))))
        return out
    except Exception:  # noqa: BLE001 - figure 레그 실패는 figures:[]로만 강등
        logger.exception("figure 검색 실패 — figures 빈 목록으로 강등")
        return []


@router.post("")
async def retrieve(
    body: RetrieveBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """질의 -> {figures[], degraded}. 항상 200 (검색은 부가 기능)."""
    question = body.question.strip()
    if not question:
        return {"figures": [], "degraded": True}
    try:
        vec = await upstage.embed_query(question)
    except Exception:  # noqa: BLE001 - 검색은 부가 기능, 절대 클라를 깨지 않는다
        logger.exception("retrieve failed — degraded 응답")
        return {"figures": [], "degraded": True}
    # figure는 자체 try/except 레그 — 실패는 figures:[]로만 강등.
    figure_items = await _search_figures(user, body.session_id, vec)
    return {"figures": figure_items, "degraded": False}
