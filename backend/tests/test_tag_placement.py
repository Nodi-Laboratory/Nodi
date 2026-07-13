import math
from app.services.canvas_layout import tag_anchor, place_by_tag, ExistingCard, _overlap, CANVAS_W, CANVAS_H


def test_tag_anchor_center_and_deterministic():
    assert tag_anchor(0) == (CANVAS_W / 2.0, CANVAS_H / 2.0)
    assert tag_anchor(3) == tag_anchor(3)
    assert tag_anchor(1) != tag_anchor(0)


def test_tag_anchors_separated():
    a0, a1, a2 = tag_anchor(0), tag_anchor(1), tag_anchor(2)
    assert math.hypot(a1[0] - a0[0], a1[1] - a0[1]) >= 400
    assert math.hypot(a2[0] - a1[0], a2[1] - a1[1]) >= 200


def test_place_by_tag_clusters_no_overlap():
    a0 = tag_anchor(0)
    existing: list[ExistingCard] = []
    for _ in range(4):
        x, y = place_by_tag(a0, existing, 200.0)
        for c in existing:
            assert _overlap(x, y, 200.0, c.x, c.y, c.h, 0.0) is None
        existing.append(ExistingCard(x=x, y=y, h=200.0))
    # 앵커 주변 조밀(카드 중심이 앵커에서 멀지 않음)
    for c in existing:
        assert math.hypot((c.x + 210) - a0[0], (c.y + 100) - a0[1]) < 1400
