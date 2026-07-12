"""캔버스 그리드 배치 모듈 — frontend/src/lib/concept/layout.ts 포팅.

결정론적 그리드: 카드가 겹치지 않도록 셀 단위로 관리.
클러스터 해시 앵커는 이번 구현에서 제외됨.

상수:
  CANVAS_W / CANVAS_H — 캔버스 크기
  MARGIN              — 좌측·상단 여백
  FX / FY             — 셀 가로/세로 스텝
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# 상수 (스펙 §4, brief §그리드 배치)
# ---------------------------------------------------------------------------
CANVAS_W = 2600
CANVAS_H = 1600
MARGIN = 40
FX = 460   # 카드 폭(420) + 여백(40)
FY = 840   # 카드 높이(800) + 여백(40)


# ---------------------------------------------------------------------------
# 셀 ↔ 픽셀 변환
# ---------------------------------------------------------------------------

def cell_to_xy(col: int, row: int) -> tuple[int, int]:
    """셀 (col, row) → 픽셀 (x, y). 브리프: x = 40 + col*460, y = 40 + row*840."""
    return (MARGIN + col * FX, MARGIN + row * FY)


def xy_to_cell(x: float, y: float) -> tuple[int, int]:
    """픽셀 (x, y) → 셀 (col, row). round + 음수 클램프(layout.ts:63-66 대응)."""
    col = max(0, round((x - MARGIN) / FX))
    row = max(0, round((y - MARGIN) / FY))
    return (col, row)


# ---------------------------------------------------------------------------
# 가장 가까운 빈 셀 탐색 (layout.ts:68-87 포팅)
# ---------------------------------------------------------------------------

def nearest_free_cell(
    anchor: tuple[int, int],
    occupied: set[str],
) -> tuple[int, int]:
    """앵커 셀에서 가장 가까운 빈 셀을 탐색.

    layout.ts nearestFreeCell 로직과 동일:
      R = 4..128 step 4 링(ring)으로 후보를 구성 → d2 오름차순 정렬 → 빈 셀 반환.
    col/row < 0인 후보는 건너뜀.
    """
    a_col, a_row = anchor
    for R in range(4, 132, 4):
        cands: list[tuple[int, int, int]] = []  # (d2, row, col)
        for dc in range(-R, R + 1):
            for dr in range(-R, R + 1):
                col = a_col + dc
                row = a_row + dr
                if col < 0 or row < 0:
                    continue
                dx = dc * FX
                dy = dr * FY
                cands.append((dx * dx + dy * dy, row, col))
        # d2 오름차순, 동률은 row 오름차순, 그 다음 col 오름차순 (layout.ts:81)
        cands.sort()
        for d2, row, col in cands:
            key = f"{col},{row}"
            if key not in occupied:
                return (col, row)
    # 안전 폴백 (사실상 도달하지 않음)
    return (a_col, a_row + 1000)


# ---------------------------------------------------------------------------
# 폴백 앵커 계산
# ---------------------------------------------------------------------------

def fallback_anchor(canvas_cards: list[dict]) -> tuple[int, int]:
    """세션 canvas_cards 포인트 목록에서 앵커 셀을 계산.

    - 0개 → 셀 (0, 0)
    - 있으면 created_at 최대 포인트의 (x, y) 셀

    canvas_cards: qdrant_store.scroll_canvas_cards() 반환값
    각 항목: {"payload": {"x": int, "y": int, "created_at": float, ...}}
    """
    if not canvas_cards:
        return (0, 0)
    # payload.created_at 기준 최대값 포인트
    best = max(
        canvas_cards,
        key=lambda p: (p.get("payload") or {}).get("created_at") or 0.0,
    )
    payload = best.get("payload") or {}
    x = payload.get("x") or MARGIN
    y = payload.get("y") or MARGIN
    return xy_to_cell(x, y)


# ---------------------------------------------------------------------------
# 점유 셋 구성 헬퍼
# ---------------------------------------------------------------------------

def build_occupied(canvas_cards: list[dict]) -> set[str]:
    """canvas_cards 포인트 목록 → 점유 셀 키 집합."""
    occupied: set[str] = set()
    for pt in canvas_cards:
        payload = pt.get("payload") or {}
        x = payload.get("x")
        y = payload.get("y")
        if x is None or y is None:
            continue
        col, row = xy_to_cell(x, y)
        occupied.add(f"{col},{row}")
    return occupied
