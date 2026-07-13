from app.services.canvas_layout import estimate_card_height
from app.config import get_settings

S = get_settings()

# 힘 솔버(place_new_card/target_distance)는 태그 배치로 대체되어 제거됨.
# 무겹침·클러스터 배치는 test_tag_placement.py가 커버한다. 여기엔 아직 쓰이는
# estimate_card_height(카드 높이 clamp) 회귀 가드만 남긴다.


def test_estimate_card_height_clamped_monotonic():
    assert estimate_card_height(0) == S.card_h_min
    assert estimate_card_height(10_000) == S.card_h_max
    assert estimate_card_height(4) >= estimate_card_height(2)
