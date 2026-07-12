"""canvas_layout.py 유닛 테스트 — TDD RED → GREEN.

테스트 항목:
  - 결정론(같은 입력→같은 셀)
  - 점유 회피(occupied 셀은 반환하지 않음)
  - 폴백 규칙(0개 카드 → (0,0) 셀 = (40,40))
  - cell_to_xy / xy_to_cell 라운드트립
"""

import pytest

from app.services.canvas_layout import (
    MARGIN,
    FX,
    FY,
    cell_to_xy,
    xy_to_cell,
    nearest_free_cell,
    fallback_anchor,
)


# ---------------------------------------------------------------------------
# cell_to_xy
# ---------------------------------------------------------------------------
def test_cell_to_xy_origin():
    """셀 (0,0) → 좌표 (MARGIN, MARGIN)."""
    x, y = cell_to_xy(0, 0)
    assert x == MARGIN  # 40
    assert y == MARGIN  # 40


def test_cell_to_xy_col1():
    """셀 (1,0) → x = MARGIN + FX."""
    x, y = cell_to_xy(1, 0)
    assert x == MARGIN + FX  # 500
    assert y == MARGIN  # 40


def test_cell_to_xy_row1():
    """셀 (0,1) → y = MARGIN + FY."""
    x, y = cell_to_xy(0, 1)
    assert x == MARGIN  # 40
    assert y == MARGIN + FY  # 880


# ---------------------------------------------------------------------------
# xy_to_cell — round + 음수 클램프
# ---------------------------------------------------------------------------
def test_xy_to_cell_origin():
    col, row = xy_to_cell(MARGIN, MARGIN)
    assert col == 0 and row == 0


def test_xy_to_cell_round_trip():
    """cell_to_xy → xy_to_cell가 원래 셀로 돌아온다."""
    for c in range(5):
        for r in range(2):
            x, y = cell_to_xy(c, r)
            cc, rr = xy_to_cell(x, y)
            assert (cc, rr) == (c, r), f"Round-trip failed for ({c},{r})"


def test_xy_to_cell_negative_clamped():
    """음수 좌표는 col/row 0으로 클램프."""
    col, row = xy_to_cell(-100, -100)
    assert col == 0 and row == 0


# ---------------------------------------------------------------------------
# nearest_free_cell
# ---------------------------------------------------------------------------
def test_nearest_free_cell_empty():
    """점유 없으면 앵커 셀 자체를 반환."""
    cell = nearest_free_cell((0, 0), set())
    assert cell == (0, 0)


def test_nearest_free_cell_occupied_anchor():
    """앵커가 점유되면 다른 셀을 반환."""
    occupied = {"0,0"}
    cell = nearest_free_cell((0, 0), occupied)
    assert cell != (0, 0)


def test_nearest_free_cell_avoids_all_occupied():
    """여러 셀 점유 — 반환 셀은 occupied에 없다."""
    occupied = {"0,0", "1,0", "0,1", "1,1"}
    cell = nearest_free_cell((0, 0), occupied)
    col, row = cell
    assert f"{col},{row}" not in occupied


def test_nearest_free_cell_deterministic():
    """같은 입력 → 같은 결과(결정론)."""
    occupied = {"0,0", "1,0"}
    c1 = nearest_free_cell((0, 0), occupied)
    c2 = nearest_free_cell((0, 0), occupied)
    assert c1 == c2


def test_nearest_free_cell_no_negative():
    """반환 셀의 col, row는 항상 0 이상."""
    cell = nearest_free_cell((0, 0), set())
    col, row = cell
    assert col >= 0 and row >= 0


# ---------------------------------------------------------------------------
# fallback_anchor — 세션 카드 없으면 (0,0), 있으면 created_at 최대 포인트의 셀
# ---------------------------------------------------------------------------
def test_fallback_anchor_empty():
    """카드 0개 → 셀 (0,0)."""
    anchor = fallback_anchor([])
    assert anchor == (0, 0)


def test_fallback_anchor_picks_latest():
    """created_at 최대 포인트의 (x,y)에서 셀을 반환."""
    cards = [
        {"payload": {"x": MARGIN, "y": MARGIN, "created_at": 100.0}},  # 셀 (0,0)
        {"payload": {"x": MARGIN + FX, "y": MARGIN, "created_at": 200.0}},  # 셀 (1,0)
    ]
    anchor = fallback_anchor(cards)
    assert anchor == (1, 0)  # created_at=200.0 포인트의 셀
