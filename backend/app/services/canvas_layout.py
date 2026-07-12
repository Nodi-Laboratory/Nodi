"""캔버스 그리드 배치 모듈 — frontend/src/lib/concept/layout.ts 포팅.

결정론적 그리드: 카드가 겹치지 않도록 셀 단위로 관리.
클러스터 해시 앵커는 이번 구현에서 제외됨.

상수:
  CANVAS_W / CANVAS_H — 캔버스 크기
  MARGIN              — 좌측·상단 여백
  FX / FY             — 셀 가로/세로 스텝
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..config import get_settings

_S = get_settings()

# ---------------------------------------------------------------------------
# 상수 (스펙 §4, brief §그리드 배치)
# ---------------------------------------------------------------------------
CANVAS_W = 2600
CANVAS_H = 1600
MARGIN = 40
FX = 460   # 카드 폭(420) + 여백(40)
FY = 840   # 카드 높이(800) + 여백(40)


# ---------------------------------------------------------------------------
# 힘-기반 클러스터 배치(spec 2026-07-12-force-cluster). 순수 함수·결정론.
# 격자 상수 FX/FY는 Task 5에서 제거. CANVAS_W/CANVAS_H/MARGIN은 위 정의 재사용.
# ---------------------------------------------------------------------------


@dataclass
class ExistingCard:
    """이완 대상에서 제외되는(pin) 기존 카드. sim은 '새 카드와의' 코사인 유사도[0,1]."""
    x: float
    y: float
    h: float
    sim: float


def target_distance(sim: float) -> float:
    """유사도 → 목표 거리. sim>=S_MERGE→0(동일 군집), sim<S_MIN→D_MAX(분리)."""
    s = max(0.0, min(1.0, sim))
    if s >= _S.force_s_merge:
        return 0.0
    if s < _S.force_s_min:
        return _S.force_d_max
    frac = (_S.force_s_merge - s) / (_S.force_s_merge - _S.force_s_min)
    return _S.force_d_max * (frac ** _S.force_gamma)


def estimate_card_height(body_lines: int) -> float:
    """본문 줄 수 → 카드 높이(clamp). done 시점 본문으로 산출."""
    h = _S.card_h_min + max(0, body_lines) * _S.card_h_per_line
    return max(_S.card_h_min, min(_S.card_h_max, h))


def _radius(h: float) -> float:
    """CARD_W × h 카드의 외접원 반경(충돌 판정용)."""
    return 0.5 * math.hypot(_S.card_w, h)


def place_new_card(
    new_h: float, existing: list[ExistingCard], count_seed: int
) -> tuple[float, float]:
    """새 카드 좌표를 결정론적으로 계산. 기존 카드는 고정.

    - 초기값: softmax(sim/TAU) 가중 무게중심. 무유사(max_sim<S_MIN)면 전역
      무게중심에서 황금각 방향으로 D_MAX 떨어진 빈 영역 시드(결정론, count_seed 사용).
    - 이완: 스트레스 경사(‖p-p_i‖ - target)² 하강 + 충돌 밀어내기, 쿨링 ITERS회.
    """
    if not existing:
        return (CANVAS_W / 2.0, CANVAS_H / 2.0)

    new_r = _radius(new_h)
    targets = [(c, target_distance(c.sim)) for c in existing]
    # 가중치: 유사 카드가 군집 인력을 지배하도록. 비유사도 분리엔 기여(0.2).
    weights = [c.sim if c.sim >= _S.force_s_min else 0.2 for c in existing]

    # 초기 추정: softmax 가중 무게중심
    exps = [math.exp(c.sim / _S.force_tau) for c in existing]
    z = sum(exps) or 1.0
    px = sum(e * c.x for e, c in zip(exps, existing)) / z
    py = sum(e * c.y for e, c in zip(exps, existing)) / z

    # 결정론 시드 방향(황금각). softmax 무게중심이 기존 카드와 정확히 겹칠 때
    # 충돌 밀어내기 방향(dx/dist)이 0이 되어 카드가 그 위에 갇히는 것을 막는다.
    # 무유사 시드에도 재사용. 미소 오프셋이라 비축퇴 경우엔 영향이 없다.
    seed_ang = math.radians(count_seed * 137.5)
    px += math.cos(seed_ang) * 1.0
    py += math.sin(seed_ang) * 1.0

    max_sim = max(c.sim for c in existing)
    if max_sim < _S.force_s_min:
        gx = sum(c.x for c in existing) / len(existing)
        gy = sum(c.y for c in existing) / len(existing)
        ang = math.radians(count_seed * 137.5)  # 황금각 — 결정론 분산
        px = gx + math.cos(ang) * _S.force_d_max
        py = gy + math.sin(ang) * _S.force_d_max

    t = _S.force_t0
    for _ in range(_S.force_iters):
        gx_ = 0.0
        gy_ = 0.0
        for (c, d), w in zip(targets, weights):
            dx = px - c.x
            dy = py - c.y
            dist = math.hypot(dx, dy) or 1e-6
            coef = 2.0 * w * (dist - d) / dist  # 스트레스 경사
            gx_ += coef * dx
            gy_ += coef * dy
        px -= _S.force_k_attr * t * gx_
        py -= _S.force_k_attr * t * gy_
        # 충돌 해소: 가변 반경 겹침 밀어내기
        for c in existing:
            dx = px - c.x
            dy = py - c.y
            dist = math.hypot(dx, dy) or 1e-6
            min_d = new_r + _radius(c.h) + _S.force_min_gap
            if dist < min_d:
                push = (min_d - dist)
                px += (dx / dist) * push * _S.force_k_rep
                py += (dy / dist) * push * _S.force_k_rep
        t *= _S.force_alpha

    # 캔버스 경계 클램프
    px = max(MARGIN, min(CANVAS_W - _S.card_w - MARGIN, px))
    py = max(MARGIN, min(CANVAS_H - new_h - MARGIN, py))
    return (px, py)


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
