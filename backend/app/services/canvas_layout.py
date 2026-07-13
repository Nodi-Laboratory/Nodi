"""캔버스 힘-기반 카드 배치 모듈.

상수:
  CANVAS_W / CANVAS_H — 캔버스 크기
  MARGIN              — 좌측·상단 여백
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..config import get_settings

_S = get_settings()

# ---------------------------------------------------------------------------
# 상수
# ---------------------------------------------------------------------------
CANVAS_W = 3200
CANVAS_H = 2200
MARGIN = 40


# ---------------------------------------------------------------------------
# 힘-기반 클러스터 배치(spec 2026-07-12-force-cluster). 순수 함수·결정론.
# CANVAS_W/CANVAS_H/MARGIN은 위 정의 재사용.
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


# 힘 이완 후 남은 겹침을 완전히 제거하는 최종 하드 분리 반복 상한.
_HARD_SEP_ITERS = 200


def _overlap(
    ax: float, ay: float, ah: float,
    bx: float, by: float, bh: float,
    gap: float = 0.0,
) -> tuple[float, float] | None:
    """두 카드의 AABB(좌상단 (ax,ay)/(bx,by), 폭 CARD_W, 높이 ah/bh) 겹침 판정.

    좌표는 프론트 렌더와 동일하게 **좌상단** 기준. gap을 포함해 두 축 모두에서
    겹치면 (pen_x, pen_y) 최소 침투량을 반환(양수), 한 축이라도 gap 이상
    떨어져 있으면 None. 외접원과 달리 가변 높이에서도 실제 사각형 무겹침을
    정확히 판정한다.
    """
    w = _S.card_w
    dcx = ax - bx  # 같은 폭이라 중심 x 차이 = 좌상단 x 차이
    dcy = (ay + ah / 2.0) - (by + bh / 2.0)
    pen_x = (w + gap) - abs(dcx)
    pen_y = (ah + bh) / 2.0 + gap - abs(dcy)
    if pen_x > 0 and pen_y > 0:
        return pen_x, pen_y
    return None


def _aabb_push(
    px: float, py: float, new_h: float, c: ExistingCard, k: float
) -> tuple[float, float]:
    """new 카드가 c와 (MIN_GAP 포함) 겹치면 최소 침투 축으로 k배 밀어낸 좌표.

    최소이동벡터(MTV): 침투가 작은 축으로만 밀어 카드가 필요 이상 흩어지지
    않게 한다. 겹치지 않으면 그대로 반환.
    """
    pen = _overlap(px, py, new_h, c.x, c.y, c.h, _S.force_min_gap)
    if pen is None:
        return px, py
    pen_x, pen_y = pen
    if pen_x <= pen_y:
        sx = 1.0 if (px - c.x) >= 0 else -1.0
        px += sx * pen_x * k
    else:
        dcy = (py + new_h / 2.0) - (c.y + c.h / 2.0)
        sy = 1.0 if dcy >= 0 else -1.0
        py += sy * pen_y * k
    return px, py


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
        # 충돌 해소: AABB 최소이동벡터로 밀어내기(가변 높이 정확)
        for c in existing:
            px, py = _aabb_push(px, py, new_h, c, _S.force_k_rep)
        t *= _S.force_alpha

    # 캔버스 경계 클램프
    px = max(MARGIN, min(CANVAS_W - _S.card_w - MARGIN, px))
    py = max(MARGIN, min(CANVAS_H - new_h - MARGIN, py))

    # 1차 하드 분리: 매 회 모든 겹침을 최소이동축으로 밀어내 대부분 해소한다.
    for _ in range(_HARD_SEP_ITERS):
        moved = False
        for c in existing:
            nx, ny = _aabb_push(px, py, new_h, c, 1.0)
            if nx != px or ny != py:
                px, py = nx, ny
                moved = True
        px = max(MARGIN, min(CANVAS_W - _S.card_w - MARGIN, px))
        py = max(MARGIN, min(CANVAS_H - new_h - MARGIN, py))
        if not moved:
            break

    # 무겹침 보장: 조밀 포화(동일 목표거리 0 다수)에서 하드 분리가 못 비운 경우,
    # 힘이 정한 위치에서 나선으로 가장 가까운 빈 자리를 찾는다(결정론). 캔버스에
    # 빈 공간이 있는 한 반드시 무겹침 위치를 반환한다 — "카드끼리 겹치면 안 됨" 보장.
    if any(
        _overlap(px, py, new_h, c.x, c.y, c.h, _S.force_min_gap) is not None
        for c in existing
    ):
        px, py = _first_free_position(px, py, new_h, existing)

    return (px, py)


def _first_free_position(
    px: float, py: float, new_h: float, existing: list[ExistingCard]
) -> tuple[float, float]:
    """힘이 정한 (px,py)에서 나선으로 확장하며 어떤 기존 카드와도 안 겹치는
    가장 가까운 위치를 찾아 반환(결정론). 못 찾으면 마지막 후보를 반환."""
    step = _S.card_w / 3.0  # 탐색 간격(카드 폭보다 촘촘히 → 좁은 틈도 포착)

    def _clamp(x: float, y: float) -> tuple[float, float]:
        return (
            max(MARGIN, min(CANVAS_W - _S.card_w - MARGIN, x)),
            max(MARGIN, min(CANVAS_H - new_h - MARGIN, y)),
        )

    def _free(x: float, y: float) -> bool:
        return all(
            _overlap(x, y, new_h, c.x, c.y, c.h, _S.force_min_gap) is None
            for c in existing
        )

    for ring in range(0, 80):
        if ring == 0:
            cx, cy = _clamp(px, py)
            if _free(cx, cy):
                return (cx, cy)
            continue
        r = ring * step
        samples = ring * 8  # 링마다 각 샘플 수 증가(간격 일정 유지)
        for k in range(samples):
            ang = 2.0 * math.pi * k / samples
            cx, cy = _clamp(px + r * math.cos(ang), py + r * math.sin(ang))
            if _free(cx, cy):
                return (cx, cy)
    return _clamp(px, py)
