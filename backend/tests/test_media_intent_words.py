"""직접 말한 그림·영상 요청을 낱말로 읽는 부분 (사용자 지시 2026-08-12).

⚠️ **D210 7-1의 "낱말은 판정을 안 한다"를 뒤집은 자리다.** 그 규칙의 근거는
"한국어 표현이 다양해 문자열로는 못 가른다"였고 지금도 맞다 — 다만 그 대가가
**기능이 아예 안 뜨는 것**이었다(사용자 보고: "직접 말하는데 작동을 안 해").
모델이 `set_media_intent`를 안 부르면 갈래 자체가 안 생기는데, 모델이 곁들이
도구를 자주 건너뛴다는 것은 D163이 이미 못 박아 둔 사실이다.

그래서 낱말은 **모델의 선언을 대신하지 않고 없을 때만 대신 선다.**
"""

from app.ai.orchestrator import _explicit_media, _media_topic


def test_종류를_콕_집으면_그것만_본다():
    assert _explicit_media("지진파 영상만 추천해줘") == ({"clip"}, True)
    assert _explicit_media("광합성 이미지 추천해줘") == ({"figure"}, False)


def test_둘_다_말하면_둘_다다():
    kinds, only = _explicit_media("그림이랑 영상 같이 보여줘")
    assert kinds == {"figure", "clip"}
    assert only is False


def test_그림_영상_얘기가_없으면_요청이_아니다():
    assert _explicit_media("삼투압이 뭐야") == (set(), False)


def test_만은_낱말_바로_뒤에서만_센다():
    """"만" 하나로 세면 "고맙습니다만"이 자료만 달라는 뜻이 된다."""
    assert _explicit_media("고맙습니다만") == (set(), False)
    kinds, only = _explicit_media("영상 보여주면 고맙습니다만")
    assert kinds == {"clip"}
    assert only is False


def test_주제어는_요청_표현을_걷어낸다():
    """문장 그대로 검색하면 "추천해줘"가 임베딩을 끌고 가 거리 게이트를
    넘긴다(D210 7-1 실측: "지진파 영상만 추천해줘" 3/3 빈손)."""
    assert _media_topic("지진파 영상만 추천해줘") == "지진파"
    assert _media_topic("광합성 관련 이미지 보여줘") == "광합성"


def test_남는_것이_없으면_원문을_쓴다():
    """주제어가 문장에 아예 없으면 지어내지 않는다 — 원문으로 찾는다."""
    q = "이미지만 보여줘"
    assert _media_topic(q) == q
    q2 = "그림이랑 영상 같이 보여줘"
    assert _media_topic(q2) == q2
