"""교과서 figure 표시·서명 공용 헬퍼 (TASK 4, D87).

/retrieve figures 레그와 GET /files/figures/{id} 재수화 엔드포인트가 공유한다.
signed URL은 영속하지 않고(D87) 요청 시 발급 — service-role 미설정·발급 실패 시
None으로 강등해 호출부가 best-effort로 처리한다(url 없는 figure 노드 방지).
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from ..db.client import get_service_client

logger = logging.getLogger("nodi.figures")
settings = get_settings()


def display_caption(row: dict[str, Any]) -> str:
    """표시용 캡션: 판정 선택(candidates[selected_index]) 우선 → 위치기반 caption
    → alt (labs search.py 표시 규약, figure_judge.final_embed_text와 동형 선택).

    candidates는 문자열 리스트(figure_extract.rank_candidates). selected_index가
    유효 범위(0 이상, 후보 개수 미만)면 그 후보를, -1/null/범위밖이면 caption
    (없으면 alt)을 쓴다 — judge의 보수적 판정이 위치기반 캡션을 지우지 않게.
    """
    candidates = row.get("candidates")
    idx = row.get("selected_index")
    if (
        isinstance(idx, int)
        and idx >= 0
        and isinstance(candidates, list)
        and idx < len(candidates)
    ):
        chosen = candidates[idx]
        if isinstance(chosen, str) and chosen.strip():
            return chosen.strip()
    caption = (row.get("caption") or "").strip()
    if caption:
        return caption
    return (row.get("alt") or "").strip()


async def sign_figure_url(row: dict[str, Any]) -> str | None:
    """image_path에 signed URL 발급(D87). service-role 미설정·발급 실패 시 None —
    호출부가 best-effort로 처리한다. TTL=settings.figure_signed_url_ttl_seconds.

    서명은 service-role 필요(Storage sign RPC) — RLS 재조회로 접근을 이미
    검증한 행에 한해 호출된다(신뢰 경계는 textbook_figures 재조회가 담당).
    """
    path = row.get("image_path")
    if not path:
        return None
    service = get_service_client()
    if service is None:
        return None
    try:
        return await service.storage_sign(
            settings.storage_bucket, path, settings.figure_signed_url_ttl_seconds
        )
    except Exception:  # noqa: BLE001 - 서명 실패는 best-effort 강등(None)
        logger.warning("figure signed URL 발급 실패 (path=%s)", path, exc_info=True)
        return None


def figure_item(
    row: dict[str, Any], url: str | None, score: float | None = None
) -> dict[str, Any]:
    """응답 항목 조립: {figure_id, file_id, page, caption, url, score?}.

    score는 Qdrant 랭킹 노출용(선택) — None이면 키를 생략한다.
    """
    item: dict[str, Any] = {
        "figure_id": row.get("id"),
        "file_id": row.get("file_id"),
        "page": row.get("page"),
        "caption": display_caption(row),
        "url": url,
    }
    if score is not None:
        item["score"] = score
    return item

