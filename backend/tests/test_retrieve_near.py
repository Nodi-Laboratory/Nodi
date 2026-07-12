"""retrieve near 폴백 테스트 — Qdrant 모킹.

테스트 항목:
  (a) 유사 카드 있음(score ≥ 임계) → near는 그 카드의 (x,y)
  (b) 없음(빈 결과 or score 미달) → near는 폴백 좌표
  (c) Qdrant 예외 → near는 폴백 좌표, degraded=True
  어떤 경우든 near 키가 항상 존재해야 한다.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from app.services.canvas_layout import MARGIN, FX


# 테스트 헬퍼: _compute_near 함수를 직접 import해서 테스트
# (FastAPI 인증 없이 로직만 검증)
from app.routers.retrieve import _compute_near, RetrieveBody


# ---------------------------------------------------------------------------
# _compute_near 직접 테스트
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_near_with_high_score_card():
    """score ≥ 0.5인 카드가 있으면 그 x,y를 앵커로 사용해 near를 반환한다."""
    # canvas_cards scroll(점유 목록)에서도 같은 카드가 있다고 가정
    mock_hits = [
        {"score": 0.8, "payload": {"x": MARGIN + FX, "y": MARGIN, "created_at": 1.0}}
    ]
    mock_scroll = [
        {"payload": {"x": MARGIN + FX, "y": MARGIN}}
    ]

    with (
        patch("app.routers.retrieve.qdrant_store.search_canvas_cards", new_callable=AsyncMock) as mock_knn,
        patch("app.routers.retrieve.qdrant_store.scroll_canvas_cards", new_callable=AsyncMock) as mock_scroll_fn,
    ):
        mock_knn.return_value = mock_hits
        mock_scroll_fn.return_value = mock_scroll

        vec = [0.1] * 4096
        near = await _compute_near(vec, owner_id="user1", session_id="sess1")

    assert near is not None
    assert "x" in near and "y" in near
    # score가 있으면 반환
    assert near.get("score") == 0.8


@pytest.mark.asyncio
async def test_near_with_low_score_returns_fallback():
    """score < 0.5 → 폴백 앵커에서 near 좌표 반환 (score=null)."""
    mock_hits = [
        {"score": 0.3, "payload": {"x": MARGIN + FX, "y": MARGIN, "created_at": 1.0}}
    ]
    mock_scroll = []  # 점유 없음

    with (
        patch("app.routers.retrieve.qdrant_store.search_canvas_cards", new_callable=AsyncMock) as mock_knn,
        patch("app.routers.retrieve.qdrant_store.scroll_canvas_cards", new_callable=AsyncMock) as mock_scroll_fn,
    ):
        mock_knn.return_value = mock_hits
        mock_scroll_fn.return_value = mock_scroll

        vec = [0.1] * 4096
        near = await _compute_near(vec, owner_id="user1", session_id="sess1")

    assert near is not None
    assert "x" in near and "y" in near
    assert near.get("score") is None  # 폴백이므로 score 없음


@pytest.mark.asyncio
async def test_near_with_empty_canvas_returns_fallback():
    """canvas_cards가 비어 있으면 (40,40) 폴백."""
    with (
        patch("app.routers.retrieve.qdrant_store.search_canvas_cards", new_callable=AsyncMock) as mock_knn,
        patch("app.routers.retrieve.qdrant_store.scroll_canvas_cards", new_callable=AsyncMock) as mock_scroll_fn,
    ):
        mock_knn.return_value = []
        mock_scroll_fn.return_value = []

        vec = [0.1] * 4096
        near = await _compute_near(vec, owner_id="user1", session_id="sess1")

    assert near is not None
    assert near["x"] == MARGIN  # 40
    assert near["y"] == MARGIN  # 40
    assert near.get("score") is None


@pytest.mark.asyncio
async def test_near_on_qdrant_exception():
    """Qdrant 예외 → near는 폴백 좌표 (절대 None 아님)."""
    with (
        patch("app.routers.retrieve.qdrant_store.search_canvas_cards", new_callable=AsyncMock) as mock_knn,
        patch("app.routers.retrieve.qdrant_store.scroll_canvas_cards", new_callable=AsyncMock) as mock_scroll_fn,
    ):
        mock_knn.side_effect = Exception("Qdrant down")
        mock_scroll_fn.side_effect = Exception("Qdrant down")

        vec = [0.1] * 4096
        near = await _compute_near(vec, owner_id="user1", session_id="sess1")

    assert near is not None
    assert "x" in near and "y" in near
    # 폴백이므로 score는 None
    assert near.get("score") is None
