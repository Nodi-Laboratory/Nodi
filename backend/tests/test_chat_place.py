import math

from app.routers.chat import _place_for_new_concept
from app.services.canvas_layout import ExistingCard, estimate_card_height


def test_place_for_new_concept_returns_continuous_coords():
    existing = [ExistingCard(x=1300, y=800, h=200, sim=0.95)]
    x, y = _place_for_new_concept(existing, seed=1, new_h=estimate_card_height(2))
    assert isinstance(x, float) and isinstance(y, float)
    # 유사 카드 곁(겹치지 않음)
    d = math.hypot(x - 1300, y - 800)
    assert d > 0


def test_place_for_new_concept_empty_existing_is_center():
    from app.services.canvas_layout import CANVAS_W, CANVAS_H

    x, y = _place_for_new_concept([], seed=0, new_h=estimate_card_height(2))
    assert x == CANVAS_W / 2.0
    assert y == CANVAS_H / 2.0
