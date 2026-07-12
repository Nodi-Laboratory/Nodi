import math
from app.services.canvas_layout import (
    ExistingCard, target_distance, estimate_card_height, place_new_card,
    CANVAS_W, CANVAS_H,
)
from app.config import get_settings

S = get_settings()


def test_target_distance_merge_and_separate():
    assert target_distance(0.95) == 0.0          # >= S_MERGE → 0
    assert target_distance(0.10) == S.force_d_max # < S_MIN → D_MAX
    mid = target_distance(0.55)                   # 중간 → (0, D_MAX)
    assert 0.0 < mid < S.force_d_max
    # 단조: 유사도 높을수록 거리 짧다
    assert target_distance(0.70) < target_distance(0.40)


def test_estimate_card_height_clamped_monotonic():
    assert estimate_card_height(0) == S.card_h_min
    assert estimate_card_height(10_000) == S.card_h_max
    assert estimate_card_height(4) >= estimate_card_height(2)


def test_first_card_is_center():
    assert place_new_card(200.0, [], 0) == (CANVAS_W / 2.0, CANVAS_H / 2.0)


def test_deterministic():
    existing = [ExistingCard(x=1300, y=800, h=200, sim=0.9)]
    a = place_new_card(200.0, existing, 1)
    b = place_new_card(200.0, existing, 1)
    assert a == b


def test_similar_converges_close():
    # 하나의 유사 카드(sim=0.95, 목표거리 0) → 새 카드는 그 곁 MIN_GAP 근방
    c = ExistingCard(x=1300, y=800, h=200, sim=0.95)
    x, y = place_new_card(200.0, [c], 1)
    dist = math.hypot(x - c.x, y - c.y)
    # 겹치지 않는 최소 간격 이상, 그러나 D_MAX 근처는 아님(조밀 군집)
    from app.services.canvas_layout import _radius
    min_d = _radius(200.0) + _radius(200.0) + S.force_min_gap
    assert min_d - 1 <= dist <= min_d + 120


def test_dissimilar_pushed_far():
    # sim=0.1(목표거리 D_MAX) 카드 → 새 카드는 멀리
    c = ExistingCard(x=1300, y=800, h=200, sim=0.1)
    x, y = place_new_card(200.0, [c], 1)
    dist = math.hypot(x - c.x, y - c.y)
    assert dist >= S.force_d_max * 0.5   # 최소 절반 이상 분리


def test_no_overlap_variable_size():
    existing = [
        ExistingCard(x=1000, y=800, h=160, sim=0.9),
        ExistingCard(x=1200, y=820, h=560, sim=0.88),
    ]
    x, y = place_new_card(400.0, existing, 2)
    from app.services.canvas_layout import _radius
    for c in existing:
        d = math.hypot(x - c.x, y - c.y)
        assert d >= _radius(400.0) + _radius(c.h) + S.force_min_gap - 1
