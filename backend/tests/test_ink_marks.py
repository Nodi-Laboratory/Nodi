"""펜 표시 해석 (D178) — 프롬프트 조립과 출력 파싱.

VLM 호출 자체는 mock이다. 여기서 지키는 것은 **모델에 무엇을 시키는가**와
**모델이 뭘 뱉든 우리가 안 깨지는가** 둘이다.
"""

from app.services import ink_marks


def test_정상_출력을_번호와_설명으로_가른다():
    out = "가리킴: 2\n설명: 화살표가 [카드 2]를 가리킨다. [카드 1]은 닿지 않는다."
    pointed, note = ink_marks.parse_marks(out)
    assert pointed == 2
    assert note.startswith("화살표가 [카드 2]")


def test_가리키는_카드가_없으면_None():
    pointed, note = ink_marks.parse_marks("가리킴: 없음\n설명: 동그라미만 있다.")
    assert pointed is None
    assert note == "동그라미만 있다."


def test_설명이_여러_줄이어도_다_가져온다():
    out = "가리킴: 1\n설명: 첫 줄.\n둘째 줄.\n셋째 줄."
    _, note = ink_marks.parse_marks(out)
    assert "둘째 줄." in note and "셋째 줄." in note


def test_형식을_어기면_전체를_설명으로_본다():
    """모델이 형식을 벗어나도 **버리지 않는다** — 설명은 여전히 쓸모가 있다."""
    pointed, note = ink_marks.parse_marks("화살표가 지질학 카드를 가리킨다.")
    assert pointed is None
    assert note == "화살표가 지질학 카드를 가리킨다."


def test_빈_출력은_빈_결과():
    assert ink_marks.parse_marks("") == (None, "")
    assert ink_marks.parse_marks("   \n  ") == (None, "")


def test_번호가_숫자가_아니면_None():
    pointed, _ = ink_marks.parse_marks("가리킴: 지질학\n설명: 뭔가.")
    assert pointed is None


def test_명부에_없는_번호는_버린다():
    """VLM이 9를 말했는데 카드가 3장이면 매핑이 어긋난다 — 조용히 틀리느니 버린다."""
    pointed, _ = ink_marks.parse_marks("가리킴: 9\n설명: 뭔가.", card_count=3)
    assert pointed is None


def test_0이나_음수도_버린다():
    assert ink_marks.parse_marks("가리킴: 0\n설명: 뭔가.", card_count=3)[0] is None
    assert ink_marks.parse_marks("가리킴: -1\n설명: 뭔가.", card_count=3)[0] is None


def test_프롬프트에_카드_명부가_텍스트로_들어간다():
    """이미지 속 작은 제목을 읽게 시키면 틀린다 — 그림에서 풀 문제는 기하뿐이다."""
    cards = [{"n": 1, "title": "천문학"}, {"n": 2, "title": "지질학"}]
    msgs = ink_marks.build_marks_messages(cards, "data:image/png;base64,AAA", None, None)
    text = "".join(
        p["text"]
        for m in msgs
        for p in m["content"]
        if isinstance(p, dict) and p.get("type") == "text"
    )
    assert "1 = 천문학" in text
    assert "2 = 지질학" in text


def test_도판_확대본이_있으면_두_번째_그림을_설명한다():
    cards = [{"n": 1, "title": "지질학"}]
    msgs = ink_marks.build_marks_messages(
        cards, "data:image/png;base64,AAA", "data:image/png;base64,BBB", 1
    )
    parts = [p for m in msgs for p in m["content"] if isinstance(p, dict)]
    images = [p for p in parts if p.get("type") == "image_url"]
    text = "".join(p["text"] for p in parts if p.get("type") == "text")
    assert len(images) == 2
    assert "두 번째 그림" in text and "[카드 1]" in text


def test_도판이_없으면_그림은_한_장():
    msgs = ink_marks.build_marks_messages(
        [{"n": 1, "title": "지질학"}], "data:image/png;base64,AAA", None, None
    )
    images = [
        p
        for m in msgs
        for p in m["content"]
        if isinstance(p, dict) and p.get("type") == "image_url"
    ]
    assert len(images) == 1


def test_시스템_프롬프트가_세_지시를_담는다():
    s = ink_marks.MARKS_SYSTEM
    # 없으면 작은 모델의 요약이 큰 모델의 근거가 된다
    assert "설명하지 마라" in s
    # 없으면 뭉뚱그려서 SOLAR가 카드 셋 다 설명한다 — 이 지시가 배제의 전부다
    assert "닿지 않았다고" in s
    # 없으면 id 매핑이 문자열 추측이 된다
    assert "[카드 N]" in s
