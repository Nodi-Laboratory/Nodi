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


def test_설명_줄만_읽는다():
    """번호는 더 이상 모델에게 묻지 않는다 — 기하가 센다(inkScene.markOf)."""
    out = "설명: 화살표가 [카드 2]를 짚었다. [카드 1]은 스쳐 지나갔다."
    assert ink_marks.parse_marks(out).startswith("화살표가 [카드 2]")


def test_형식을_어기면_전체를_설명으로_본다():
    """모델이 형식을 벗어나도 **버리지 않는다** — 설명은 여전히 쓸모가 있다."""
    assert ink_marks.parse_marks("화살표가 지질학 카드를 짚었다.") == (
        "화살표가 지질학 카드를 짚었다."
    )


def test_빈_출력은_빈_문자열():
    assert ink_marks.parse_marks("") == ""
    assert ink_marks.parse_marks("   \n  ") == ""


def test_명부에_기하_판정이_사실로_실린다():
    """모델에게 **묻지 않고 알려 준다.** 불확실할 때 늘 1번을 답하던 문제가
    여기서 끝난다 — 고를 일이 없으면 틀릴 일도 없다."""
    cards = [
        {"n": 1, "title": "천문학", "where": "맨 윗줄 왼쪽", "mark": "circled"},
        {"n": 2, "title": "지질학", "where": "맨 윗줄 가운데", "mark": "crossed"},
    ]
    msgs = ink_marks.build_marks_messages(cards, "data:image/png;base64,AAA", None, None)
    text = [p for p in msgs[0]["content"] if p.get("type") == "text"][-1]["text"]
    assert "1 = 천문학 (맨 윗줄 왼쪽) — 동그라미가 이 카드를 감쌌다" in text
    assert "2 = 지질학 (맨 윗줄 가운데) — 표시가 위를 스쳐 지나가기만 했다" in text
    # 고르라고 하지 않는다.
    assert "가리킴:" not in text
    # **결론까지 적어 준다.** 사실에서 유도하게 두면 작은 모델이 틀린다.
    assert "→ 학생이 묻는 대상: [카드 1]" in text


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
    assert out.block.splitlines() == [
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
    assert out.block == "[카드 3] 생명공학: 셋"


@pytest.mark.asyncio
async def test_본문은_상한만큼_자른다():
    client = _FakeClient([{"id": U1, "title": "지질학", "body": "가" * 500}])
    out = await canvas_items.ink_cards_context(client, "s-1", [U1], 10)
    assert out.block == "[카드 1] 지질학: " + "가" * 10


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
    assert out.block == "[카드 2] 지질학: 둘"
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

    # 킬 스위치는 **오버레이**가 정한다 (D62) — `settings`만 patch하면 실제
    # 콘솔 동작과 갈린다(점검 2026-08-06: 그래서 안 꺼지는 것을 못 잡았다).
    async def overlay():
        return {"ink_vlm_enabled": True}

    monkeypatch.setattr(ink_marks.app_settings, "get_overlay", overlay)


@pytest.mark.asyncio
async def test_모델_응답에서_설명을_받는다(vision_on):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return _reply("가리킴: 2\n설명: 화살표가 [카드 2]를 가리킨다.")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(CARDS, b"png", client=c)

    assert (got.note, got.status) == ("화살표가 [카드 2]를 가리킨다.", "ok")
    assert seen["url"].endswith("/chat/completions")
    # 이미지가 data URI로 실렸나 — 경로가 아니라 바이트를 보낸다.
    parts = seen["body"]["messages"][0]["content"]
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
    assert (got.note, got.status) == ("", "error")


@pytest.mark.asyncio
async def test_모델이_끊겨도_질문을_막지_않는다(vision_on):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("연결 실패")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(CARDS, b"png", client=c)
    assert (got.note, got.status) == ("", "error")


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
    # **부르지 않았다는 것이 요점이다.** 상태로도, 호출 여부로도 확인한다 —
    # 상태만 보면 "불렀는데 실패했다"와 구분이 안 된다.
    assert not called
    assert (got.note, got.status) == ("", "unconfigured")


@pytest.mark.asyncio
async def test_킬_스위치를_내리면_안_부른다(vision_on, monkeypatch):
    async def off():
        return {"ink_vlm_enabled": False}

    monkeypatch.setattr(ink_marks.app_settings, "get_overlay", off)
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return _reply("가리킴: 1\n설명: 뭔가.")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(CARDS, b"png", client=c)
    assert not called
    assert (got.note, got.status) == ("", "off")


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

        # 킬 스위치는 오버레이가 정한다 (D62).
        async def off():
            return {"ink_vlm_enabled": False}

        monkeypatch.setattr(ink_marks.app_settings, "get_overlay", off)
        assert (await ink_marks.read_marks(CARDS, b"png", client=c)).status == "off"


def test_형식_지시가_맨_끝에_있다():
    """**이 순서가 이 프롬프트의 전부다.**

    실측 2026-08-05(EXAONE-4.5-33B): 형식 지시를 앞에만 두면 모델이 통째로
    무시하고 800자 마크다운 에세이를 뱉었다 — `가리킴:` 줄이 없어 번호 파싱이
    실패했다. 그림 직후의 마지막 지시라야 이긴다.
    """
    msgs = ink_marks.build_marks_messages(
        [{"n": 1, "title": "지질학"}], "data:image/png;base64,AAA", None, None
    )
    # 메시지는 user 하나뿐 — system에 두면 묻힌다.
    assert len(msgs) == 1 and msgs[0]["role"] == "user"
    text = [p for p in msgs[0]["content"] if p.get("type") == "text"][-1]["text"]
    assert text.rstrip().endswith("설명: <빨간 표시를 옮겨 적은 한국어 2~4문장>")
    # 그림이 글보다 앞이다(figure_caption과 같은 모양).
    assert msgs[0]["content"][0]["type"] == "image_url"


def test_도판_설명은_형식_지시보다_앞이다():
    msgs = ink_marks.build_marks_messages(
        [{"n": 2, "title": "지질학"}],
        "data:image/png;base64,AAA",
        "data:image/png;base64,BBB",
        2,
    )
    text = [p for p in msgs[0]["content"] if p.get("type") == "text"][-1]["text"]
    assert text.index("두 번째 그림") < text.index("한 줄만")


def test_시스템_프롬프트가_핵심_지시를_담는다():
    s = ink_marks.MARKS_SYSTEM
    # 없으면 작은 모델의 요약이 큰 모델의 근거가 된다
    assert "설명하지 마라" in s
    # 고르는 일을 맡기지 않는다 — 기하가 이미 정했다.
    # 줄바꿈이 낀 자리라 공백을 눌러서 본다(줄 폭 때문에 문장이 접힌다).
    assert "네가 고르는 것이 아니다" in " ".join(s.split())
    # 없으면 id 매핑이 문자열 추측이 된다
    assert "[카드 N]" in s


# ────────────────────── 표시 문장 (D178, 2026-08-05) ──────────────────────
#
# 카드마다 낱말 하나만 주던 시절에는 "화살표가 [카드 1]에서 [카드 3]으로
# 향한다"를 **말할 방법이 없었다** — 방향은 카드 둘 사이의 관계라 어느 한
# 카드에도 안 딸린다. 그래서 표시를 주어로 하는 문장을 따로 만든다.


def test_화살표는_출발과_도착을_한_문장으로_말한다():
    line = ink_marks.gesture_line(
        {"shape": "arrow", "from": [1], "points": [3], "crosses": [2],
         "encloses": [], "within": []}
    )
    assert "화살표가 [카드 1]에서 시작해 [카드 3]으로 향한다" in line
    # 스쳐 간 카드는 **스쳐 갔다고 말해야** 배제가 된다(부정 진술 강제).
    assert "[카드 2]는 위를 스쳐 지나가기만 하고 멈추지 않는다" in line


def test_동그라미가_여럿을_감싼_것을_말한다():
    line = ink_marks.gesture_line(
        {"shape": "circle", "encloses": [1, 2], "within": [], "points": [],
         "from": [], "crosses": []}
    )
    assert "동그라미가 [카드 1]과 [카드 2]를 통째로 감쌌다" in line


def test_카드_안에_그은_표시를_구분해_말한다():
    line = ink_marks.gesture_line(
        {"shape": "underline", "within": [2], "encloses": [], "points": [],
         "from": [], "crosses": []}
    )
    assert "[카드 2]를 두른 상자 **안쪽에** 밑줄을 그었다" in line


def test_조사를_숫자_읽기에_맞춘다():
    """작은 모델에게 어색한 한국어를 주면 어색한 한국어가 돌아온다.

    1(일)·3(삼)은 받침이 있어 "을", 2(이)·4(사)는 "를". "으로/로"는 ㄹ받침이
    갈린다 — 1은 "1로", 3은 "3으로".
    """
    def ro(a: int, b: int) -> str:
        return ink_marks.gesture_line(
            {"shape": "arrow", "from": [a], "points": [b], "encloses": [],
             "within": [], "crosses": []}
        )

    assert "[카드 3]으로 향한다" in ro(2, 3)
    assert "[카드 1]로 향한다" in ro(2, 1)
    def eul(n: int) -> str:
        return ink_marks.gesture_line(
            {"shape": "circle", "encloses": [n], "within": [], "points": [],
             "from": [], "crosses": []}
        )

    assert "[카드 1]을 통째로" in eul(1)
    assert "[카드 2]를 통째로" in eul(2)


def test_어디에도_안_닿은_표시도_말한다():
    line = ink_marks.gesture_line(
        {"shape": "circle", "encloses": [], "within": [], "points": [],
         "from": [], "crosses": []}
    )
    assert "어느 카드에도 닿지 않았다" in line


def test_모르는_모양은_그냥_표시라고_부른다():
    """프론트가 새 모양을 추가해도 프롬프트에 빈칸이 생기지 않는다."""
    line = ink_marks.gesture_line(
        {"shape": "별표", "points": [1], "encloses": [], "within": [],
         "from": [], "crosses": []}
    )
    assert "표시의 끝이 [카드 1]을 가리키며" in line


def test_표시_목록이_프롬프트에_실린다():
    cards = [
        {"n": 1, "title": "지질학", "where": "맨 윗줄 왼쪽", "mark": "linked"},
        {"n": 3, "title": "생명공학", "where": "맨 아랫줄 가운데", "mark": "pointed"},
    ]
    gestures = [
        {"shape": "arrow", "from": [1], "points": [3], "encloses": [],
         "within": [], "crosses": []}
    ]
    msgs = ink_marks.build_marks_messages(
        cards, "data:image/png;base64,AAA", None, None, gestures
    )
    text = [p for p in msgs[0]["content"] if p.get("type") == "text"][-1]["text"]
    assert "학생이 그린 표시 1개" in text
    assert "[카드 1]에서 시작해 [카드 3]으로 향한다" in text
    # 출발점은 대상이 아니다 — 결론 줄에 [카드 1]이 들어가면 SOLAR가 둘 다 설명한다.
    assert "→ 학생이 묻는 대상: [카드 3]" in text
    # 표시 목록도 형식 지시보다 앞이어야 한다(마지막 지시가 이긴다).
    assert text.index("학생이 그린 표시") < text.index("한 줄만")


def test_짚은_것이_없으면_없다고_말하게_한다():
    """빈칸으로 두면 모델이 아무 카드나 고른다 — 실측 2026-08-05: 늘 1번."""
    msgs = ink_marks.build_marks_messages(
        [{"n": 1, "title": "지질학", "mark": "crossed"}],
        "data:image/png;base64,AAA", None, None, [],
    )
    text = [p for p in msgs[0]["content"] if p.get("type") == "text"][-1]["text"]
    assert "어느 카드도 확실히 짚지 않았다" in text


def test_출발점은_짚은_것으로_치지_않는다():
    """`POINTING`은 프론트 `POINTING_KINDS`와 같아야 한다 — 갈리면 화면의
    부모 노드와 SOLAR가 받는 대상이 어긋난다."""
    assert set(ink_marks.POINTING) == {"circled", "within", "pointed"}
    assert "linked" not in ink_marks.POINTING
    assert "crossed" not in ink_marks.POINTING


def test_모양_이름에도_조사를_맞춘다():
    """"밑줄가"·"동그라미이"가 나오면 안 된다 — 이 글을 읽는 것이 작은 모델이다."""
    def line(shape: str) -> str:
        return ink_marks.gesture_line(
            {"shape": shape, "encloses": [2], "within": [], "points": [],
             "from": [], "crosses": []}
        )
    assert line("underline").startswith("밑줄이 ")
    assert line("circle").startswith("동그라미가 ")
    assert line("line").startswith("선이 ")


# ───────────── 짚은 카드를 SOLAR에게 단정해서 준다 (2026-08-05) ─────────────
#
# 사용자 보고: "vlm에서 카드 2를 가리킨다고 말해도 solar는 다른 카드에 대해서
# 설명하는데?" — 대상이 **비전 모델이 쓴 산문 안에만** 있었기 때문이다. 그
# 산문은 트리 지도·자료 블록 사이에 끼여 있고, SOLAR는 자주 다른 흐름을 따라갔다.
# 어느 카드를 짚었는지는 기하가 이미 정확히 안다 — 추론시킬 일이 아니다.


@pytest.mark.asyncio
async def test_짚은_카드에_표를_달고_따로_뽑아_준다():
    client = _FakeClient([
        {"id": U1, "title": "지질학", "body": "하나", "tag": None},
        {"id": U2, "title": "천문학", "body": "둘", "tag": None},
    ])
    out = await canvas_items.ink_cards_context(
        client, "s-1", [U1, U2], 1200, [2]
    )
    assert out.targets == ["[카드 2] 천문학"]
    lines = out.block.splitlines()
    assert lines[0] == "[카드 1] 지질학: 하나"
    # 결론 줄 하나는 긴 프롬프트에서 묻힌다 — 카드 줄에도 표를 단다.
    assert lines[1] == "[카드 2] 천문학 ← 학생이 짚은 카드: 둘"


@pytest.mark.asyncio
async def test_짚은_것이_없으면_대상도_비운다():
    """지어내지 않는다 — 비어 있으면 "확실히 짚은 것이 없다"가 사실이다."""
    client = _FakeClient([{"id": U1, "title": "지질학", "body": "하나", "tag": None}])
    out = await canvas_items.ink_cards_context(client, "s-1", [U1], 1200, [])
    assert out.targets == []
    assert "짚은 카드" not in out.block


@pytest.mark.asyncio
async def test_없는_카드는_대상이_될_수_없다():
    """번호는 맞는데 그 카드가 지워졌다면 대상에서도 빠져야 한다 — 안 빼면
    프롬프트가 본문 없는 카드를 가리키라고 시킨다."""
    client = _FakeClient([{"id": U2, "title": "천문학", "body": "둘", "tag": None}])
    out = await canvas_items.ink_cards_context(
        client, "s-1", [U1, U2], 1200, [1, 2]
    )
    assert out.targets == ["[카드 2] 천문학"]
