"""concept_blocks.py 유닛 테스트 — TDD RED → GREEN.

테스트 항목:
  - 0개 개념 파싱
  - 1개 개념 파싱 (마크업 제거 포함)
  - 2개 개념 파싱 (index 순서)
  - @end 누락 내성
  - 마크업(**bold**, ==highlight==) 제거
"""

import pytest

from app.services.concept_blocks import parse


SAMPLE_1 = """\
CHAT: 안녕하세요!

@concept: 미분 | 수학
- **미분**은 함수의 순간 변화율이다.
- ==극한값==으로 정의된다.
@end
"""

SAMPLE_2 = """\
CHAT: 두 개 개념

@concept: 미분 | 수학
- **미분**은 변화율이다.
@end

@concept: 적분 | 수학
- ==적분==은 넓이다.
@end
"""

SAMPLE_0 = """\
CHAT: 개념 없음
단순 텍스트만.
"""

SAMPLE_NO_END = """\
@concept: 극한 | 수학
- 극한은 수렴값이다.
@concept: 연속 | 수학
- 연속 함수.
@end
"""


# ---------------------------------------------------------------------------
# 0개 개념
# ---------------------------------------------------------------------------
def test_parse_zero():
    result = parse(SAMPLE_0)
    assert result == []


# ---------------------------------------------------------------------------
# 1개 개념
# ---------------------------------------------------------------------------
def test_parse_one_index():
    result = parse(SAMPLE_1)
    assert len(result) == 1
    assert result[0]["index"] == 0


def test_parse_one_title():
    result = parse(SAMPLE_1)
    assert result[0]["title"] == "미분"


def test_parse_one_markup_removed():
    """** 와 == 마크업이 body에서 제거되어야 한다."""
    result = parse(SAMPLE_1)
    body = result[0]["body"]
    assert "**" not in body
    assert "==" not in body
    assert "미분" in body
    assert "극한값" in body


# ---------------------------------------------------------------------------
# 2개 개념
# ---------------------------------------------------------------------------
def test_parse_two_count():
    result = parse(SAMPLE_2)
    assert len(result) == 2


def test_parse_two_indices():
    result = parse(SAMPLE_2)
    assert result[0]["index"] == 0
    assert result[1]["index"] == 1


def test_parse_two_titles():
    result = parse(SAMPLE_2)
    assert result[0]["title"] == "미분"
    assert result[1]["title"] == "적분"


def test_parse_two_markup_removed():
    result = parse(SAMPLE_2)
    for block in result:
        assert "**" not in block["body"]
        assert "==" not in block["body"]


# ---------------------------------------------------------------------------
# @end 누락 내성 — 다음 @concept이 이전 개념을 닫는다
# ---------------------------------------------------------------------------
def test_parse_no_end_tolerance():
    """@end 없이 다음 @concept이 나올 때 이전 개념이 정상 추출되어야 한다."""
    result = parse(SAMPLE_NO_END)
    assert len(result) == 2
    assert result[0]["title"] == "극한"
    assert result[1]["title"] == "연속"
