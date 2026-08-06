"""히스토리 위생 (D197) — 형식이 깨진 답을 그대로 되먹이지 않는다.

## 왜 이 테스트가 있나

모델이 `@concept:` 봉투를 빠뜨린 답을 한 번 내면, 그 답이 다음 턴의 assistant
메시지로 들어가 **모델이 자기를 따라 한다.** 실측(2026-08-07, solar-pro3,
같은 질문 6회씩):

    히스토리 없음           @concept 있음  5/6
    형식 지킨 답 1개                       3/6
    형식 깨진 답 1개                       0/6   ← 되돌아오지 않는다
    형식 깨진 답 2개                       0/6

학생에게는 이렇게 보인다: 답은 멀쩡히 생성되고 토큰도 다 오는데 **캔버스에는
아무것도 안 뜬다.** 오류도 로그도 없어서, 이 결함은 UI 시나리오를 끝까지
태워 보고서야 드러났다.
"""

from __future__ import annotations

from app.services import solar

봉투_없는_답 = (
    "광합성은 식물이 빛 에너지를 이용해 **이산화탄소**와 **물**을 "
    "**포도당**으로 바꾸는 과정이에요."
)
봉투_있는_답 = "CHAT: 안녕!\n@concept: 광합성 | 식물의 생장\n본문\n@end"


def test_봉투가_있으면_손대지_않는다():
    """멀쩡한 답을 다시 포장하면 `@concept`가 둘이 되고 파서가 카드를 둘로 센다."""
    assert solar.canonical_answer(봉투_있는_답) == 봉투_있는_답


def test_봉투가_없으면_씌운다():
    out = solar.canonical_answer(봉투_없는_답)
    assert out.startswith("@concept:")
    assert out.rstrip().endswith("@end")
    assert 봉투_없는_답 in out  # 본문은 한 글자도 안 바뀐다


def test_제목은_첫_굵은_낱말에서_빌린다():
    """프론트 되살리기(streamParser)와 **같은 규칙**이다 — 두 곳이 같은 답을
    같은 제목으로 불러야 학생이 새로고침 전후로 다른 제목을 안 본다."""
    assert solar.canonical_answer(봉투_없는_답).startswith("@concept: 이산화탄소")


def test_분류를_알면_함께_적는다():
    """실측(각 8회): 제목만 4/8 · 제목+분류 6/8. 반쪽짜리 예시는 오히려 나쁘다."""
    out = solar.canonical_answer(봉투_없는_답, "식물의 생장")
    assert out.splitlines()[0] == "@concept: 이산화탄소 | 식물의 생장"


def test_굵은_낱말이_없으면_제목_없이_둔다():
    """지어내지 않는다 — 없는 제목을 만들면 학생이 안 쓴 말이 화면에 남는다."""
    assert solar.canonical_answer("굵은 글씨가 없는 문장입니다.").startswith("@concept:\n")


def test_빈_답은_그대로():
    assert solar.canonical_answer("") == ""


def test_히스토리의_깨진_답이_봉투를_쓴_채_들어간다():
    msgs = solar._build_messages("시스템", [("질문", 봉투_없는_답)], "다음 질문", "생물")
    assistant = [m for m in msgs if m["role"] == "assistant"]
    assert len(assistant) == 1
    assert assistant[0]["content"].startswith("@concept: 이산화탄소 | 생물")


def test_히스토리가_있으면_형식을_한_번_더_못박는다():
    """시스템 프롬프트는 히스토리가 길어질수록 멀어진다 — 질문 직전에 되풀이한다."""
    msgs = solar._build_messages("시스템", [("질문", 봉투_있는_답)], "다음 질문")
    assert msgs[-1]["role"] == "user"
    assert msgs[-2]["content"] == solar.FORMAT_REMINDER


def test_첫_턴에는_되새김을_붙이지_않는다():
    """바로 위에 시스템 프롬프트가 있는데 또 말하면 토큰만 쓴다."""
    msgs = solar._build_messages("시스템", [], "첫 질문")
    assert [m["role"] for m in msgs] == ["system", "user"]
