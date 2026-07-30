"""D118 — figure_caption 비전 캡션 생성 클라이언트 테스트.

figure_judge와 동형 구조(JUDGE_TIMEOUT·회로차단 5·재시도 1회, judge_* 설정으로
호출)를 검증한다. 외부 호출 없음: caption_one을 monkeypatch로 가짜 교체하거나
httpx.MockTransport로 요청을 가로챈다.

figure_judge의 판정 '선택'과 달리 캡션 '생성'이므로 parse는 텍스트 정규화·절단만
한다(빈 캡션은 None 취급). caption_all은 judge_all 구조를 복제하되 각 항목 완료
시 heartbeat(있으면)를 await한다.
"""

import asyncio

import httpx
import pytest

from app.services import figure_caption as FC


@pytest.fixture(autouse=True)
def _judge_endpoint(monkeypatch):
    """더미 판정 엔드포인트(D97) — figure_judge와 같은 judge_* 설정 재사용."""
    monkeypatch.setattr(FC.settings, "judge_base_url", "http://judge.test/v1")
    monkeypatch.setattr(FC.settings, "judge_model", "EXAONE-4.5-33B")
    monkeypatch.setattr(FC.settings, "judge_api_key", "k")


def _caption_response(text: str) -> httpx.Response:
    """정상 캡션 생성 응답(OpenAI 호환 chat/completions shape)."""
    return httpx.Response(
        200,
        json={"choices": [{"message": {"content": text}, "finish_reason": "stop"}]},
    )


def _empty_response() -> httpx.Response:
    """content 없는 응답 — _call_caption이 ValueError를 던지게 한다."""
    return httpx.Response(
        200,
        json={"choices": [{"message": {"content": None}, "finish_reason": "length"}]},
    )


# --- build_caption_messages -------------------------------------------------

def test_build_caption_messages_페이지_컨텍스트_포함():
    """단일 user 턴 안에 image_url + 페이지 본문·parsed 캡션·환각금지 지시가 들어간다."""
    msgs = FC.build_caption_messages(
        "가야 토기는 회청색이다.", "그림 3 가야 토기", "토기 사진", "data:image/png;base64,xx"
    )
    assert len(msgs) == 1 and msgs[0]["role"] == "user"
    parts = msgs[0]["content"]
    assert parts[0]["type"] == "image_url"
    assert parts[0]["image_url"]["url"] == "data:image/png;base64,xx"
    text = parts[1]["text"]
    assert "가야 토기는 회청색" in text          # 페이지 본문
    assert "그림 3 가야 토기" in text            # parsed 캡션(고유명사 보존 지시)
    assert "토기 사진" in text                   # alt
    assert "지어내" in text                      # 환각 금지 지시


def test_build_caption_messages_힌트_없으면_힌트블록_생략():
    """parsed 캡션·alt가 비면 힌트 라벨을 넣지 않는다(불필요한 프롬프트 잡음 제거)."""
    msgs = FC.build_caption_messages("본문만 있다.", "", "", "data:image/png;base64,xx")
    text = msgs[0]["content"][1]["text"]
    assert "파서가 찾은 원문 캡션" not in text  # 힌트 라벨(base 지시문 '원문 캡션이 있으면'과 구분)
    assert "대체 텍스트" not in text
    assert "본문만 있다." in text


def test_build_caption_messages_거대_힌트_정규화_절단():
    """파서가 alt에 페이지 전문(탭·개행 포함 수 KB)을 넣어도 힌트는 HINT_LIMIT로
    잘려 들어간다 — 실측(2026-07-30): 원본을 그대로 실으면 모델이 빈 응답을
    반복해 해당 figure만 결정론적으로 caption-error가 났다."""
    giant_alt = ("페이지\t전문\n덤프 " * 2000).strip()  # 탭·개행 섞인 ~14KB
    msgs = FC.build_caption_messages(
        "본문", "그림 1 첨성대\t\n관측", giant_alt, "data:image/png;base64,xx"
    )
    text = msgs[0]["content"][1]["text"]
    hint_line = next(l for l in text.splitlines() if l.startswith("대체 텍스트: "))
    assert len(hint_line) <= len("대체 텍스트: ") + FC.HINT_LIMIT
    assert "\t" not in hint_line                 # 탭 정규화(reasoning 폭주 방지)
    parsed_line = next(l for l in text.splitlines() if l.startswith("파서가 찾은 원문 캡션: "))
    assert parsed_line == "파서가 찾은 원문 캡션: 그림 1 첨성대 관측"


# --- parse_caption ----------------------------------------------------------

def test_parse_caption_정규화_절단():
    """공백(탭 포함) 정규화 + 500자 캡."""
    assert FC.parse_caption("  가야   토기\t사진  ") == "가야 토기 사진"
    assert len(FC.parse_caption("가" * 900)) == 500


def test_parse_caption_빈_응답은_빈문자열():
    """빈·공백뿐인 응답은 '' (caption_all이 None으로 강등)."""
    assert FC.parse_caption("") == ""
    assert FC.parse_caption("   \t\n  ") == ""


# --- caption_one (httpx MockTransport, 외부 호출 없음) ----------------------

async def test_caption_one_retries_empty_content_then_succeeds():
    """빈 content(ValueError) → 1회 재시도 후 성공(judge_one 재시도 규약 재사용)."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return _empty_response() if calls["n"] == 1 else _caption_response("가야 토기")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        out = await FC.caption_one(client, "본문", "캡션", "alt", b"\xff\xd8\xff", "jpg")

    assert calls["n"] == 2
    assert out == "가야 토기"


async def test_caption_one_raises_after_two_failures():
    """재시도까지 실패(빈 content 2회)면 ValueError를 던진다."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return _empty_response()

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ValueError):
            await FC.caption_one(client, "본문", "캡션", "alt", b"\xff\xd8\xff", "jpg")
    assert calls["n"] == 2


async def test_caption_one_sends_labs_request_params():
    """요청 payload가 judge 파라미터(모델·enable_thinking False 등)를 담는다."""
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        captured["body"] = _json.loads(request.content)
        return _caption_response("캡션")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await FC.caption_one(client, "본문", "캡션", "alt", b"\xff\xd8\xff", "jpg")

    assert captured["url"].endswith("/chat/completions")
    assert captured["auth"] == "Bearer k"
    body = captured["body"]
    assert body["model"] == "EXAONE-4.5-33B"
    assert body["chat_template_kwargs"] == {"enable_thinking": False}


# --- caption_all ------------------------------------------------------------

def _item(**over) -> dict:
    base = {
        "image_bytes": b"\xff\xd8\xff",
        "ext": "jpg",
        "page_text": "본문",
        "parsed_caption": "캡션",
        "alt": "alt",
    }
    base.update(over)
    return base


async def test_caption_all_정상_경로_순서_보존(monkeypatch):
    """caption_one 성공 → items 순서대로 캡션 리스트를 반환한다."""
    async def fake_caption_one(client, page_text, parsed, alt, image_bytes, ext):
        return f"cap-{page_text}"

    monkeypatch.setattr(FC, "caption_one", fake_caption_one)
    out = await FC.caption_all(
        [_item(page_text="a"), _item(page_text="b")], concurrency=2
    )
    assert out == ["cap-a", "cap-b"]


async def test_caption_all_빈_캡션은_None(monkeypatch):
    """파싱 후 빈 캡션('')은 None으로 강등한다(호출부 폴백 신호)."""
    async def fake_caption_one(*a, **k):
        return ""  # caption_one은 parse_caption 결과를 반환 — 빈 캡션은 ''

    monkeypatch.setattr(FC, "caption_one", fake_caption_one)
    out = await FC.caption_all([_item()], concurrency=1)
    assert out == [None]


async def test_caption_all_개별_실패는_None(monkeypatch):
    """개별 실패는 raise하지 않고 None(호출부가 parsed 폴백/failed 처리)."""
    async def fake_caption_one(client, page_text, parsed, alt, image_bytes, ext):
        if page_text == "boom":
            raise RuntimeError("죽은 후보")
        return "ok"

    monkeypatch.setattr(FC, "caption_one", fake_caption_one)
    out = await FC.caption_all(
        [_item(page_text="ok"), _item(page_text="boom"), _item(page_text="ok")],
        concurrency=1,
    )
    assert out == ["ok", None, "ok"]


async def test_caption_all_회로차단(monkeypatch):
    """연속 5회 실패 시 잔여 항목 생성을 생략(회로차단) — 전부 None, caption_one 5회만."""
    called = {"n": 0}

    async def always_fail(*a, **k):
        called["n"] += 1
        raise RuntimeError("죽은 엔드포인트")

    monkeypatch.setattr(FC, "caption_one", always_fail)
    items = [_item(page_text=f"c{i}") for i in range(8)]
    out = await FC.caption_all(items, concurrency=1)

    assert called["n"] == FC.CIRCUIT_BREAK_THRESHOLD == 5
    assert out == [None] * 8


async def test_caption_all_세마포어_동시성_제한(monkeypatch):
    """세마포어가 동시 호출 수를 concurrency로 제한한다."""
    state = {"cur": 0, "max": 0}

    async def slow(*a, **k):
        state["cur"] += 1
        state["max"] = max(state["max"], state["cur"])
        await asyncio.sleep(0.01)
        state["cur"] -= 1
        return "ok"

    monkeypatch.setattr(FC, "caption_one", slow)
    items = [_item(page_text=f"c{i}") for i in range(6)]
    out = await FC.caption_all(items, concurrency=2)

    assert state["max"] <= 2
    assert out == ["ok"] * 6


async def test_caption_all_하트비트_각_항목마다_호출(monkeypatch):
    """각 항목 완료 시 heartbeat가 있으면 await한다(성공·실패 무관)."""
    beats = {"n": 0}

    async def heartbeat():
        beats["n"] += 1

    async def fake_caption_one(client, page_text, parsed, alt, image_bytes, ext):
        if page_text == "boom":
            raise RuntimeError("x")
        return "ok"

    monkeypatch.setattr(FC, "caption_one", fake_caption_one)
    items = [_item(page_text="ok"), _item(page_text="boom"), _item(page_text="ok")]
    out = await FC.caption_all(items, concurrency=1, heartbeat=heartbeat)

    assert out == ["ok", None, "ok"]
    assert beats["n"] == 3  # 성공 2 + 실패 1


async def test_caption_all_회로차단_후_하트비트_생략(monkeypatch):
    """회로 개방 후 스킵된 항목은 caption_one도 heartbeat도 부르지 않는다."""
    beats = {"n": 0}

    async def heartbeat():
        beats["n"] += 1

    async def always_fail(*a, **k):
        raise RuntimeError("죽음")

    monkeypatch.setattr(FC, "caption_one", always_fail)
    items = [_item(page_text=f"c{i}") for i in range(8)]
    out = await FC.caption_all(items, concurrency=1, heartbeat=heartbeat)

    assert out == [None] * 8
    assert beats["n"] == FC.CIRCUIT_BREAK_THRESHOLD == 5  # 회로차단 전 5회만
