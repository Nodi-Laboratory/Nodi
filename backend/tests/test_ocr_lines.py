"""손글씨 OCR 줄 복원 (D177).

서버의 `text`는 조각을 **공백으로 이어 붙인** 결과라 여러 줄로 쓴 글씨가 한
줄로 뭉갠다. 캔버스 전체가 종이가 되면서(D176) 학생은 여러 줄로 쓴다 — 그걸
합치면 문장이 뒤엉킨다. 좌표로 줄을 되살린다.
"""

from app.services.ocr import lines_from_boxes


def box(text: str, x1: float, y1: float, x2: float, y2: float) -> dict:
    return {"text": text, "bbox": [x1, y1, x2, y2]}


def test_two_lines_stay_two_lines():
    out = lines_from_boxes([
        box("광합성이", 0.10, 0.10, 0.40, 0.20),
        box("뭐야", 0.45, 0.11, 0.60, 0.21),
        box("자세히", 0.10, 0.40, 0.35, 0.50),
        box("알려줘", 0.40, 0.41, 0.65, 0.51),
    ])
    assert out == "광합성이 뭐야\n자세히 알려줘"


def test_same_line_is_sorted_by_x():
    """모델이 준 순서가 아니라 **가로 위치**가 읽는 순서다."""
    out = lines_from_boxes([
        box("나중", 0.50, 0.10, 0.70, 0.20),
        box("먼저", 0.10, 0.10, 0.30, 0.20),
    ])
    assert out == "먼저 나중"


def test_big_and_small_letters_on_one_line():
    """임계를 고정 상수로 두면 큰 글씨가 쪼개진다 — 겹친 비율로 본다."""
    out = lines_from_boxes([
        box("큰", 0.10, 0.10, 0.25, 0.40),      # 높이 0.30
        box("작은", 0.30, 0.20, 0.45, 0.28),    # 높이 0.08, 큰 글자 안에 들어온다
    ])
    assert out == "큰 작은"


def test_line_span_grows_with_the_row():
    """줄의 세로 구간은 지금까지 담은 것들의 합집합이다.

    첫 글자만 기준으로 삼으면 줄 중간에 큰 글자가 오는 순간 줄이 갈라진다.
    """
    out = lines_from_boxes([
        box("가", 0.10, 0.20, 0.20, 0.26),
        box("나", 0.25, 0.10, 0.35, 0.40),   # 훨씬 큼
        box("다", 0.40, 0.30, 0.50, 0.36),   # 첫 글자와는 안 겹치지만 줄과는 겹친다
    ])
    assert out == "가 나 다"


def test_far_apart_rows_split():
    out = lines_from_boxes([
        box("위", 0.10, 0.05, 0.20, 0.12),
        box("아래", 0.10, 0.80, 0.25, 0.88),
    ])
    assert out == "위\n아래"


def test_empty_or_bad_input_yields_empty():
    """호출부가 이 빈 문자열을 보고 서버의 한 줄 text로 떨어진다."""
    assert lines_from_boxes(None) == ""
    assert lines_from_boxes([]) == ""
    assert lines_from_boxes("nope") == ""
    assert lines_from_boxes([{"text": "가"}]) == ""            # bbox 없음
    assert lines_from_boxes([{"bbox": [0, 0, 1, 1]}]) == ""     # text 없음
    assert lines_from_boxes([box("  ", 0, 0, 1, 1)]) == ""      # 공백뿐


def test_flipped_bbox_is_tolerated():
    """y가 뒤집혀 와도 같은 줄로 읽는다 — 좌표계 가정을 한 곳에서만 흡수한다."""
    out = lines_from_boxes([
        box("가", 0.10, 0.30, 0.20, 0.10),
        box("나", 0.25, 0.10, 0.35, 0.30),
    ])
    assert out == "가 나"


def test_non_numeric_bbox_is_skipped_not_fatal():
    out = lines_from_boxes([
        box("좋음", 0.10, 0.10, 0.20, 0.20),
        {"text": "나쁨", "bbox": ["a", "b", "c", "d"]},
    ])
    assert out == "좋음"


# ── 글자를 잃지 않는다 (D177) ──────────────────────────────────────────
#
# 줄을 살리는 것이 목적이지 글자를 바꾸는 것이 아니다. 박스가 본문보다 짧으면
# 학생이 쓴 글의 일부가 조용히 사라진다 — 줄이 뭉개지는 것보다 훨씬 나쁘다.

from app.services.ocr import merge_layout  # noqa: E402


def test_merge_uses_layout_when_letters_match():
    out = merge_layout("가나 다라", [
        box("가나", 0.1, 0.1, 0.3, 0.2),
        box("다라", 0.1, 0.5, 0.3, 0.6),
    ])
    assert out == "가나\n다라"


def test_merge_falls_back_when_boxes_are_short():
    """박스가 한 조각뿐이면 text를 쓴다 — 나머지를 버리지 않는다."""
    out = merge_layout("빛의  굴절이\n뭐야?", [box("빛의", 0.0, 0.0, 0.1, 0.1)])
    assert out == "빛의 굴절이 뭐야?"


def test_merge_falls_back_when_boxes_missing():
    assert merge_layout("한 줄 답", None) == "한 줄 답"
    assert merge_layout("한 줄 답", []) == "한 줄 답"


def test_merge_ignores_reordering_only():
    """줄 나눔으로 순서가 바뀌는 것은 정상 — 글자 구성이 같으면 채택한다."""
    out = merge_layout("나중 먼저", [
        box("먼저", 0.1, 0.1, 0.2, 0.2),
        box("나중", 0.5, 0.1, 0.6, 0.2),
    ])
    assert out == "먼저 나중"
