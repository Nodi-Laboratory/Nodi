"""펜 표시 해석 (D178) — 프롬프트 조립과 출력 파싱.

VLM 호출 자체는 mock이다. 여기서 지키는 것은 **모델에 무엇을 시키는가**와
**모델이 뭘 뱉든 우리가 안 깨지는가** 둘이다.
"""

import json

import httpx
import pytest

from app.services import canvas_items, gemini, ink_marks


class _FakeClient:
    """`UserClient.select`만 흉내 낸다 — 행 순서를 우리가 정할 수 있어야 한다."""

    def __init__(self, rows: list[dict]):
        self._rows = rows
        self.params: dict | None = None

    async def select(self, table: str, params: dict) -> list[dict]:
        self.params = params
        return self._rows


U1 = "11111111-1111-4111-8111-111111111111"
U2 = "22222222-2222-4222-8222-222222222222"
U3 = "33333333-3333-4333-8333-333333333333"


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
        if isinstance(m["content"], list)
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
    parts = [
        p
        for m in msgs
        if isinstance(m["content"], list)
        for p in m["content"]
        if isinstance(p, dict)
    ]
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
        if isinstance(m["content"], list)
        for p in m["content"]
        if isinstance(p, dict) and p.get("type") == "image_url"
    ]
    assert len(images) == 1


@pytest.mark.asyncio
async def test_카드_번호는_보낸_순서를_따른다():
    """**이 대응이 깨지면 SOLAR가 엉뚱한 카드를 설명하고, 그 답은 그럴싸하다.**

    DB는 순서를 보장하지 않는다 — 행이 거꾸로 와도 번호는 card_ids 순서다.
    그 번호가 도식 그림의 배지이자 marks_note의 [카드 N]이기 때문이다.
    """
    client = _FakeClient([
        {"id": U3, "title": "생명공학", "body": "셋"},
        {"id": U1, "title": "천문학", "body": "하나"},
        {"id": U2, "title": "지질학", "body": "둘"},
    ])
    out = await canvas_items.ink_cards_context(
        client, "s-1", [U1, U2, U3], 1200
    )
    assert out is not None
    assert out.splitlines() == [
        "[카드 1] 천문학: 하나",
        "[카드 2] 지질학: 둘",
        "[카드 3] 생명공학: 셋",
    ]


@pytest.mark.asyncio
async def test_없는_카드는_번호를_밀지_않고_빠진다():
    """지워졌거나 남의 카드다. **번호를 당기면** 뒤 카드가 앞 번호를 물려받아
    marks_note의 [카드 N]과 어긋난다 — 빈 번호가 그보다 안전하다."""
    client = _FakeClient([{"id": U3, "title": "생명공학", "body": "셋"}])
    out = await canvas_items.ink_cards_context(
        client, "s-1", [U1, U2, U3], 1200
    )
    assert out == "[카드 3] 생명공학: 셋"


@pytest.mark.asyncio
async def test_본문은_상한만큼_자른다():
    client = _FakeClient([{"id": U1, "title": "지질학", "body": "가" * 500}])
    out = await canvas_items.ink_cards_context(client, "s-1", [U1], 10)
    assert out == "[카드 1] 지질학: " + "가" * 10


@pytest.mark.asyncio
async def test_카드가_하나도_없으면_None():
    assert await canvas_items.ink_cards_context(_FakeClient([]), "s-1", [], 1200) is None
    assert (
        await canvas_items.ink_cards_context(_FakeClient([]), "s-1", ["x"], 1200) is None
    )


@pytest.mark.asyncio
async def test_임시_id가_섞여도_나머지_카드는_산다():
    """**실측 2026-08-05**: `tmp-4`를 uuid 열에 넘기면 asyncpg가 DataError를
    던지고, 호출부의 except가 그것을 삼켜 **표시 맥락이 통째로 사라진다.**

    캔버스에는 아직 저장 안 된 아이템이 늘 있다(이번 턴에 막 생긴 카드, 방금
    쓴 메모). 학생이 그걸 동그라미 치면 임시 id가 섞인다 — 흔한 일이지
    예외가 아니다. 하나가 성치 않다고 나머지를 버리지 않는다.
    """
    client = _FakeClient([{"id": U2, "title": "지질학", "body": "둘"}])
    out = await canvas_items.ink_cards_context(
        client, "s-1", ["tmp-4", U2, "local-note-9"], 1200
    )
    # 번호는 보낸 자리 그대로 — 임시 id 자리를 당기지 않는다.
    assert out == "[카드 2] 지질학: 둘"
    # 조회에 임시 id를 넣지 않았다(넣으면 DB가 던진다).
    assert "tmp-4" not in client.params["id"]
    assert "local-note-9" not in client.params["id"]


@pytest.mark.asyncio
async def test_전부_임시_id면_조회하지_않는다():
    client = _FakeClient([])
    assert (
        await canvas_items.ink_cards_context(client, "s-1", ["tmp-1", "tmp-2"], 1200)
        is None
    )
    assert client.params is None


def test_표시_블록은_질문에_가장_가깝게_들어간다():
    """표시는 학생이 **지금 손으로 짚은 것**이라 다른 어떤 맥락보다 직접적이다.
    앞에 두면 트리·자료에 묻힌다."""
    prompt, blocks = gemini.compose_system_structured(
        "자료 본문",
        tree_context="트리",
        ink_context="화살표가 [카드 2]를 가리킨다.",
    )
    kinds = [b["kind"] for b in blocks]
    assert "ink_marks" in kinds
    assert kinds.index("ink_marks") > kinds.index("tree_guide")
    assert "화살표가 [카드 2]를 가리킨다." in prompt


def test_표시가_없으면_블록도_없다():
    _, blocks = gemini.compose_system_structured("자료 본문")
    assert "ink_marks" not in [b["kind"] for b in blocks]


# --- read_marks (httpx MockTransport, 외부 호출 없음) ------------------------

CARDS = [{"n": 1, "title": "천문학"}, {"n": 2, "title": "지질학"}]


def _reply(content: str) -> httpx.Response:
    return httpx.Response(
        200, json={"choices": [{"message": {"content": content}}]}
    )


@pytest.fixture
def vision_on(monkeypatch):
    """비전 창구가 설정된 것으로 친다 — 로컬 .env는 비어 있다."""
    monkeypatch.setattr(ink_marks.settings, "judge_base_url", "http://vision.test/v1")
    monkeypatch.setattr(ink_marks.settings, "judge_api_key", "k")
    monkeypatch.setattr(ink_marks.settings, "ink_vlm_enabled", True)


@pytest.mark.asyncio
async def test_모델_응답을_번호와_설명으로_받는다(vision_on):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return _reply("가리킴: 2\n설명: 화살표가 [카드 2]를 가리킨다.")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(CARDS, b"png", client=c)

    assert (got.pointed, got.note, got.status) == (
        2, "화살표가 [카드 2]를 가리킨다.", "ok"
    )
    assert seen["url"].endswith("/chat/completions")
    # 이미지가 data URI로 실렸나 — 경로가 아니라 바이트를 보낸다.
    parts = seen["body"]["messages"][1]["content"]
    images = [p for p in parts if p.get("type") == "image_url"]
    assert len(images) == 1
    assert images[0]["image_url"]["url"].startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_모델이_5xx면_질문을_막지_않는다(vision_on):
    """**이것이 이 기능의 계약이다** — 표시는 곁들이고 질문은 손글씨가 나른다."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(CARDS, b"png", client=c)
        assert (got.pointed, got.note) == (None, "")


@pytest.mark.asyncio
async def test_모델이_끊겨도_질문을_막지_않는다(vision_on):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("연결 실패")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(CARDS, b"png", client=c)
        assert (got.pointed, got.note) == (None, "")


@pytest.mark.asyncio
async def test_비전_미설정이면_부르지도_않는다(monkeypatch):
    monkeypatch.setattr(ink_marks.settings, "judge_base_url", "")
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return _reply("가리킴: 1\n설명: 뭔가.")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(CARDS, b"png", client=c)
        assert (got.pointed, got.note) == (None, "")
    assert not called


@pytest.mark.asyncio
async def test_킬_스위치를_내리면_안_부른다(vision_on, monkeypatch):
    monkeypatch.setattr(ink_marks.settings, "ink_vlm_enabled", False)
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return _reply("가리킴: 1\n설명: 뭔가.")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(CARDS, b"png", client=c)
        assert (got.pointed, got.note) == (None, "")
    assert not called


@pytest.mark.asyncio
async def test_명부에_빈_번호가_있어도_큰_번호를_안_버린다(vision_on):
    """상한을 **개수**로 재면 빈 자리가 있는 명부에서 멀쩡한 답이 버려진다.
    카드 1·3만 있는데 개수는 2라, 모델이 3을 말해도 "명부 밖"이 된다."""

    def handler(request: httpx.Request) -> httpx.Response:
        return _reply("가리킴: 3\n설명: 화살표가 [카드 3]을 가리킨다.")

    roster = [{"n": 1, "title": "천문학"}, {"n": 3, "title": "지질학"}]
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(roster, b"png", client=c)
    assert got.pointed == 3


@pytest.mark.asyncio
async def test_명부_밖_번호는_버리되_설명은_남긴다(vision_on):
    def handler(request: httpx.Request) -> httpx.Response:
        return _reply("가리킴: 7\n설명: 화살표가 [카드 7]을 가리킨다.")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(CARDS, b"png", client=c)
    assert got.pointed is None
    assert got.note  # 설명은 살아 있다


@pytest.mark.asyncio
async def test_설명이_왜_비었는지를_상태로_구분한다(vision_on, monkeypatch):
    """빈 설명만으로는 꺼짐·미설정·오류를 구분할 수 없다.

    실험실이 "표시가 왜 안 읽혔나"에 답하려면 이유가 결과와 함께 와야 한다.
    실제로 이게 필요해진 계기가 있다 — 판정 서버가 TCP만 받고 0바이트로 끊는
    상태(실측 2026-08-05)에서 화면에는 "비어 있음"만 보였다.
    """

    def dead(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("끊김")

    async with httpx.AsyncClient(transport=httpx.MockTransport(dead)) as c:
        assert (await ink_marks.read_marks(CARDS, b"png", client=c)).status == "error"
        # 도식이 없으면 부를 것도 없다.
        assert (await ink_marks.read_marks(CARDS, b"", client=c)).status == "no_scene"

        monkeypatch.setattr(ink_marks.settings, "judge_base_url", "")
        assert (
            await ink_marks.read_marks(CARDS, b"png", client=c)
        ).status == "unconfigured"

        monkeypatch.setattr(ink_marks.settings, "ink_vlm_enabled", False)
        assert (await ink_marks.read_marks(CARDS, b"png", client=c)).status == "off"


def test_시스템_프롬프트가_세_지시를_담는다():
    s = ink_marks.MARKS_SYSTEM
    # 없으면 작은 모델의 요약이 큰 모델의 근거가 된다
    assert "설명하지 마라" in s
    # 없으면 뭉뚱그려서 SOLAR가 카드 셋 다 설명한다 — 이 지시가 배제의 전부다
    assert "닿지 않았다고" in s
    # 없으면 id 매핑이 문자열 추측이 된다
    assert "[카드 N]" in s
