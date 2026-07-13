from app.routers.chat import _existing_for_vec


def test_existing_for_vec_cosine_session_and_placed():
    session_cards = [
        {"payload": {"x": 100, "y": 100, "size_h": 200}, "vector": [1.0, 0.0]},
        {"payload": {"x": 200, "y": 200, "size_h": 200}, "vector": [0.0, 1.0]},
        {"payload": {"x": 300, "y": 300}, "vector": []},  # 벡터 없음 → sim 0
    ]
    placed = [(400.0, 400.0, 160.0, [1.0, 0.0])]  # 같은 답변에서 이미 배치된 개념
    vec = [1.0, 0.0]  # 배치할 개념의 passage 벡터

    out = _existing_for_vec(session_cards, placed, vec)

    assert len(out) == 4
    assert out[0].sim == 1.0   # 동일 방향
    assert out[1].sim == 0.0   # 직교
    assert out[2].sim == 0.0   # 벡터 없음
    assert out[0].x == 100.0 and out[0].h == 200.0
    # placed 개념도 대칭 코사인으로 포함
    assert out[3].sim == 1.0 and out[3].x == 400.0 and out[3].h == 160.0


def test_existing_for_vec_empty():
    assert _existing_for_vec([], [], [1.0, 0.0]) == []
