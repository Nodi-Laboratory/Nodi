import math
from app.services.canvas_layout import (
    ExistingCard, target_distance, estimate_card_height, place_new_card,
    CANVAS_W, CANVAS_H,
)
from app.config import get_settings

S = get_settings()


def test_sequential_placement_is_2d_not_collinear():
    # 회귀 가드: 카드를 순차 배치할 때 count_seed=현재 카드 수를 넘기면(황금각이
    # 카드마다 달라짐) 서로 다른 y로 퍼진다. count_seed를 0으로 고정하면(예전
    # settle 버그) 오프셋이 항상 (1,0)→모두 같은 y로 붕괴하는 1차원 퇴화가 났다.
    existing = [ExistingCard(x=1300.0, y=800.0, h=200.0, sim=0.55)]
    ys = {800}
    for _ in range(4):
        x, y = place_new_card(200.0, existing, len(existing))
        ys.add(round(y))
        existing.append(ExistingCard(x=x, y=y, h=200.0, sim=0.55))
    assert len(ys) >= 3, f"1차원 퇴화 의심 — 서로 다른 y가 부족: {ys}"


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
    # 하나의 유사 카드(sim=0.95, 목표거리 0) → 새 카드는 겹치지 않되 조밀하게 곁에.
    from app.services.canvas_layout import _overlap
    c = ExistingCard(x=1300, y=800, h=200, sim=0.95)
    x, y = place_new_card(200.0, [c], 1)
    # 겹치지 않음(AABB, gap=0)
    assert _overlap(x, y, 200.0, c.x, c.y, c.h, 0.0) is None
    # 조밀: 중심이 D_MAX보다 훨씬 가깝다(가까운 군집)
    dist = math.hypot((x + 210) - (c.x + 210), (y + 100) - (c.y + 100))
    assert dist <= S.force_d_max * 0.7


def test_dissimilar_pushed_far():
    # sim=0.1(목표거리 D_MAX) 카드 → 새 카드는 멀리
    c = ExistingCard(x=1300, y=800, h=200, sim=0.1)
    x, y = place_new_card(200.0, [c], 1)
    dist = math.hypot(x - c.x, y - c.y)
    assert dist >= S.force_d_max * 0.5   # 최소 절반 이상 분리


def _no_overlap_all(x, y, h, existing):
    from app.services.canvas_layout import _overlap
    for c in existing:
        # gap=0으로 진짜 사각형 겹침만 검사(요구: 카드끼리 겹치면 안 됨)
        assert _overlap(x, y, h, c.x, c.y, c.h, 0.0) is None, (
            f"겹침: new({x:.0f},{y:.0f},h{h:.0f}) vs ({c.x},{c.y},h{c.h})"
        )


def test_no_overlap_variable_size():
    existing = [
        ExistingCard(x=1000, y=800, h=160, sim=0.9),
        ExistingCard(x=1200, y=820, h=560, sim=0.88),
    ]
    x, y = place_new_card(400.0, existing, 2)
    _no_overlap_all(x, y, 400.0, existing)


def test_no_overlap_dense_variable_heights():
    # 요구 회귀 가드: 가변 높이 카드를 조밀 군집에 다수 배치해도 절대 안 겹친다.
    # (이전 외접원 충돌은 좌상단-중심 불일치로 가변 높이에서 겹칠 수 있었다.)
    import itertools
    heights = itertools.cycle([160.0, 300.0, 560.0, 220.0, 480.0])
    existing = [ExistingCard(x=1300.0, y=800.0, h=next(heights), sim=0.9)]
    for i in range(1, 12):
        h = next(heights)
        x, y = place_new_card(h, existing, len(existing))
        _no_overlap_all(x, y, h, existing)  # 기존 전부와 무겹침
        existing.append(ExistingCard(x=x, y=y, h=h, sim=0.9))
