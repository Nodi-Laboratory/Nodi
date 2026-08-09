"""판단 단계에 넘기는 "이 방에 뭐가 있나" 안내 (D216).

이 안내가 하는 일은 **왕복 하나를 없애는 것**이다. 판단 단계는 캔버스를 못
봐서, 학생이 "아까 그거"라고 하면 모델이 먼저 목록을 부르고 그제야 본문을
불렀다 — 우리가 이미 아는 것을 되묻는 데 LLM 호출이 통째로 쓰였다.

실측 2026-08-09(개인 방, 개념 카드 1장, 같은 질문 5회):
  전: 5.3~8.0초, 매번 `list_session_concepts` → `get_concept` (+ think 1~2회)
  후: 4.0~7.3초, 5회 중 4회가 `get_concept("광합성")` **한 번**

그래서 이 파일이 지키는 것은 문장이 아니라 **제목이 실린다**는 사실이다.
"""

from __future__ import annotations

from app.routers.chat import _HINT_TITLES, _concept_hint


def test_카드가_없으면_안내도_없다():
    """빈 안내를 넣으면 판단 프롬프트만 길어진다."""
    assert _concept_hint([]) is None
    assert _concept_hint(["", "   "]) is None


def test_제목이_그대로_실린다():
    hint = _concept_hint(["광합성", "세포호흡"])
    assert hint is not None
    assert "광합성" in hint
    assert "세포호흡" in hint
    # 무엇을 하라는 것인지도 말해 준다 — 목록만 주면 모델이 안 쓴다.
    assert "get_concept" in hint


def test_같은_제목은_한_번만():
    """같은 제목의 카드가 여럿일 수 있다(학생이 복사하거나 이어 물으면).

    중복을 그대로 실으면 안내가 길어지기만 하고 고를 것은 안 는다.
    """
    hint = _concept_hint(["광합성", "광합성", "엽록체"])
    assert hint.count("광합성") == 1


def test_많으면_최근_것을_남긴다():
    """상한을 넘으면 **뒤쪽**(최근 seq)을 남긴다.

    앞을 남기면 학생이 방금 만든 카드가 안내에서 빠진다 — "아까 그거"가
    가리키는 것은 대개 방금 것이다. 못 실린 제목은 `get_concept`이 빗나갈 때
    `available`로 돌려주는 회복 경로가 있다.
    """
    titles = [f"개념{i}" for i in range(_HINT_TITLES + 5)]
    hint = _concept_hint(titles)
    assert f"개념{_HINT_TITLES + 4}" in hint
    assert "개념0," not in hint
