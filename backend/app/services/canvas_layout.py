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
CANVAS_W = 2600
CANVAS_H = 1600
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
