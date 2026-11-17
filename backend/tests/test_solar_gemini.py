"""대화 생성 공급자 선택 — Gemini 우선, Upstage 폴백 (사용자 결정 2026-11-17 "모두 gemini로").

외부 호출 없음: `httpx.MockTransport`로 OpenAI 호환 chat/completions를 흉내 낸다.
실물 Gemini에서 확인한 사실(2026-11-17)을 계약으로 고정한다:

1. **공급자 우선순위** — Gemini 키(.env > 헤더) > Upstage 키(.env > 헤더) > 503.
   대회 운영 서버는 Gemini 키가 없어 Upstage로 계속 돌아야 하므로 폴백이 안 깨지는
   것이 이 파일의 첫 번째 관심사다.
2. **모델 매핑·허용 패턴** — 임의 문자열이 업스트림으로 나가지 않는다.
3. **키는 헤더로만** — URL·로그·예외 문자열에 없다.
4. **thought_signature** — tool_calls의 `extra_content`를 그대로 되돌려야 400이 안 난다.
5. **추론 누출 없음** — 스트림은 `content`만 답이 된다.
"""

from __future__ import annotations

import json
import logging

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.routers import health as H
from app.services import api_keys, question_coach, solar

GKEY = "AIza-GEMINI-TEST-SECRET"
UKEY = "up_UPSTAGE_TEST_SECRET"
G_URL = "https://gem.test/v1beta/openai/chat/completions"
U_URL = "https://up.test/v1/chat/completions"


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    """기본 상태: 키 없음·모델 기본값·테스트 주소. 개발자 .env 값이 새지 않는다."""
    s = solar.settings
    monkeypatch.setattr(s, "gemini_api_key", "")
    monkeypatch.setattr(s, "upstage_api_key", "")
    monkeypatch.setattr(s, "gemini_openai_base_url", "https://gem.test/v1beta/openai")
    monkeypatch.setattr(s, "upstage_base_url", "https://up.test/v1")
    monkeypatch.setattr(s, "gemini_chat_model", "gemini-3.5-flash")
    monkeypatch.setattr(s, "gemini_light_model", "gemini-3.5-flash-lite")
    monkeypatch.setattr(s, "gemini_reasoning_effort", "minimal")
    monkeypatch.setattr(s, "upstage_chat_model", "solar-pro3")
    solar._EFFORT_OVERRIDE.clear()

    async def overlay():
        return {}

    monkeypatch.setattr(solar.app_settings, "get_overlay", overlay)
    yield
    solar._EFFORT_OVERRIDE.clear()


@pytest.fixture
def header_keys():
    """앱에서 입력한 키(요청 헤더 → ContextVar)를 흉내 낸다."""
    tokens = []

    def _bind(gemini: str = "", upstage: str = ""):
        tokens.append((api_keys._gemini_key, api_keys._gemini_key.set(gemini)))
        tokens.append((api_keys._upstage_key, api_keys._upstage_key.set(upstage)))

    yield _bind
    for var, tok in reversed(tokens):
        try:
            var.reset(tok)
        except ValueError:
            var.set("")


class _Recorder:
    """MockTransport 핸들러 — 요청을 쌓고 미리 정한 응답을 차례로 돌려준다."""

    def __init__(self, *responses: httpx.Response | dict):
        self.requests: list[httpx.Request] = []
        self._responses = list(responses)

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        r = self._responses.pop(0) if len(self._responses) > 1 else self._responses[0]
        return r if isinstance(r, httpx.Response) else httpx.Response(200, json=r)

    def body(self, i: int = -1) -> dict:
        return json.loads(self.requests[i].content)


@pytest.fixture
def wire(monkeypatch):
    """solar가 만드는 AsyncClient를 MockTransport로 바꿔 끼운다."""
    real = httpx.AsyncClient

    def _install(rec: _Recorder) -> _Recorder:
        def factory(*a, **kw):
            kw["transport"] = httpx.MockTransport(rec)
            return real(*a, **kw)

        monkeypatch.setattr(solar.httpx, "AsyncClient", factory)
        return rec

    return _install


def _chat(content: str = "ok", **msg) -> dict:
    return {
        "choices": [
            {"message": {"role": "assistant", "content": content, **msg}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
    }


def _sse(*objs: dict | str) -> httpx.Response:
    lines = []
    for o in objs:
        lines.append(f"data: {o if isinstance(o, str) else json.dumps(o, ensure_ascii=False)}\n\n")
    return httpx.Response(200, content="".join(lines).encode(),
                          headers={"content-type": "text/event-stream"})


def _delta(text: str | None, **extra) -> dict:
    return {"choices": [{"delta": {"content": text, **extra}}]}


# --- 1. 공급자 우선순위 --------------------------------------------------------

async def test_gemini_키가_있으면_gemini로_간다(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    monkeypatch.setattr(solar.settings, "upstage_api_key", UKEY)  # 둘 다 있어도 Gemini
    rec = wire(_Recorder(_chat()))
    await solar.complete([{"role": "user", "content": "q"}])
    req = rec.requests[0]
    assert str(req.url) == G_URL
    assert req.headers["authorization"] == f"Bearer {GKEY}"
    body = rec.body()
    assert body["model"] == "gemini-3.5-flash"
    assert body["reasoning_effort"] == "minimal"


async def test_gemini_키가_없으면_upstage_경로가_그대로다(monkeypatch, wire):
    """대회 운영 서버 조건 — 바뀌면 안 되는 갈래."""
    monkeypatch.setattr(solar.settings, "upstage_api_key", UKEY)
    rec = wire(_Recorder(_chat()))
    await solar.complete([{"role": "user", "content": "q"}], max_tokens=512)
    req = rec.requests[0]
    assert str(req.url) == U_URL
    assert req.headers["authorization"] == f"Bearer {UKEY}"
    body = rec.body()
    assert body["model"] == "solar-pro3"
    assert body["max_tokens"] == 512
    # Upstage가 모르는 필드를 보내면 안 된다.
    assert "reasoning_effort" not in body


async def test_키가_하나도_없으면_503():
    with pytest.raises(HTTPException) as e:
        solar.resolve_route()
    assert e.value.status_code == 503
    assert solar.active_provider() is None


async def test_헤더_gemini_키도_gemini로_간다(wire, header_keys):
    header_keys(gemini=GKEY)
    rec = wire(_Recorder(_chat()))
    await solar.complete([{"role": "user", "content": "q"}])
    assert str(rec.requests[0].url) == G_URL
    assert rec.requests[0].headers["authorization"] == f"Bearer {GKEY}"


async def test_헤더_upstage_키만_있으면_upstage(wire, header_keys):
    header_keys(upstage=UKEY)
    rec = wire(_Recorder(_chat()))
    await solar.complete([{"role": "user", "content": "q"}])
    assert str(rec.requests[0].url) == U_URL


async def test_env_키가_헤더_키를_이긴다(monkeypatch, wire, header_keys):
    """비전과 같은 규칙 — 운영자가 키를 넣은 서버에서 방문자 키는 무시된다."""
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    header_keys(gemini="AIza-VISITOR-KEY")
    rec = wire(_Recorder(_chat()))
    await solar.complete([{"role": "user", "content": "q"}])
    assert rec.requests[0].headers["authorization"] == f"Bearer {GKEY}"


async def test_헤더_키는_다음_요청에_남지_않는다(wire, header_keys):
    header_keys(gemini=GKEY)
    assert solar.active_provider() == "gemini"
    api_keys._gemini_key.set("")  # 미들웨어가 요청 끝에 되돌리는 것과 같다
    assert solar.active_provider() is None


# --- 2. 모델 매핑 · 허용 패턴 ----------------------------------------------------

@pytest.mark.parametrize(
    ("requested", "expected"),
    [
        (None, "gemini-3.5-flash"),
        ("", "gemini-3.5-flash"),
        ("solar-pro3", "gemini-3.5-flash"),     # 원자화·기본 채팅
        ("solar-mini", "gemini-3.5-flash"),     # 모르는 solar 이름
        ("solar-pro2", "gemini-3.5-flash-lite"),  # 소형 작업
        ("gemini-3.6-flash", "gemini-3.6-flash"),  # 직접 고른 값은 존중
        ("gemini-3.5-flash-lite", "gemini-3.5-flash-lite"),
        # 허용 패턴 밖 — 조용히 대화 모델로 (임의 문자열이 업스트림에 안 나간다)
        ("gemini-3.5-flash; DROP", "gemini-3.5-flash"),
        ("gemini 3.5", "gemini-3.5-flash"),
        ("gemini-../../x", "gemini-3.5-flash"),
        ("Gemini-3.5-Flash", "gemini-3.5-flash"),
        ("gemini-3.5\nflash", "gemini-3.5-flash"),
    ],
)
def test_gemini_모델_매핑(requested, expected):
    assert solar.gemini_model_for(requested) == expected


def test_설정값이_허용_패턴_밖이면_기본으로_떨어진다(monkeypatch):
    monkeypatch.setattr(solar.settings, "gemini_chat_model", "evil model!")
    monkeypatch.setattr(solar.settings, "gemini_light_model", "x")
    assert solar.gemini_model_for(None) == "gemini-3.5-flash"
    assert solar.gemini_model_for("solar-pro2") == "gemini-3.5-flash-lite"


async def test_upstage_갈래에서는_gemini_이름을_보내지_않는다(monkeypatch, wire):
    """오버레이에 gemini 이름이 남은 채 Gemini 키가 사라진 경우 — 400을 막는다."""
    monkeypatch.setattr(solar.settings, "upstage_api_key", UKEY)
    rec = wire(_Recorder(_chat()))
    await solar.complete([{"role": "user", "content": "q"}], model="gemini-3.6-flash")
    assert rec.body()["model"] == "solar-pro3"
    await solar.complete([{"role": "user", "content": "q"}], model="solar-pro2")
    assert rec.body()["model"] == "solar-pro2"  # 기존 동작 불변


async def test_gemini_갈래에서_solar_이름은_옮겨진다(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    rec = wire(_Recorder(_chat()))
    await solar.complete([{"role": "user", "content": "q"}], model="solar-pro2")
    assert rec.body()["model"] == "gemini-3.5-flash-lite"
    await solar.complete([{"role": "user", "content": "q"}], model="solar-pro3")
    assert rec.body()["model"] == "gemini-3.5-flash"


# --- 3. 키 비노출 ---------------------------------------------------------------

async def test_키는_헤더로만_가고_URL_로그_예외에_없다(monkeypatch, wire, caplog):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    # 업스트림이 키를 되돌려 주는 최악의 경우 — 로그에서 지워져야 한다.
    rec = wire(_Recorder(httpx.Response(400, text=f"bad request key={GKEY} rejected")))
    with caplog.at_level(logging.DEBUG, logger="nodi.solar"):
        with pytest.raises(RuntimeError) as e:
            await solar.complete([{"role": "user", "content": "q"}])
    assert GKEY not in str(rec.requests[0].url)
    assert "key=" not in str(rec.requests[0].url)
    assert GKEY not in str(e.value)
    assert GKEY not in caplog.text
    assert GKEY not in repr(solar.resolve_route())  # Route.repr에서도 뺀다


async def test_스트리밍_오류에도_키가_안_샌다(monkeypatch, wire, caplog):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    wire(_Recorder(httpx.Response(500, text=f"boom {GKEY}")))
    with caplog.at_level(logging.DEBUG, logger="nodi.solar"):
        with pytest.raises(RuntimeError) as e:
            async for _ in solar.stream_answer([], "q", "sys"):
                pass
    assert GKEY not in str(e.value)
    assert GKEY not in caplog.text


# --- 4. tool calling — thought_signature --------------------------------------

_SIG_CALL = {
    "id": "call_1",
    "type": "function",
    "function": {"name": "search_class_material", "arguments": '{"query":"광합성"}'},
    "extra_content": {"google": {"thought_signature": "REAL-SIG"}},
}


async def test_complete는_tool_calls의_extra_content를_가공없이_돌려준다(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    wire(_Recorder(_chat("", tool_calls=[_SIG_CALL])))
    comp = await solar.complete([{"role": "user", "content": "q"}], tools=[{"type": "function"}])
    call = comp.message["tool_calls"][0]
    assert call["extra_content"]["google"]["thought_signature"] == "REAL-SIG"


async def test_2차_요청이_서명을_그대로_되돌려_보낸다(monkeypatch, wire):
    """오케스트레이터가 하는 대로: 받은 tool_calls를 assistant 메시지에 그대로 얹는다."""
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    rec = wire(_Recorder(_chat("", tool_calls=[_SIG_CALL]), _chat("끝")))
    msgs = [{"role": "user", "content": "q"}]
    first = await solar.complete(msgs, tools=[{"type": "function"}])
    msgs.append({"role": "assistant", "content": "", "tool_calls": first.message["tool_calls"]})
    msgs.append({"role": "tool", "tool_call_id": "call_1", "content": "{}"})
    await solar.complete(msgs, tools=[{"type": "function"}])
    sent = rec.body(1)["messages"][1]["tool_calls"][0]
    assert sent["extra_content"]["google"]["thought_signature"] == "REAL-SIG"


def test_서명이_없으면_더미를_첫_호출에만_얹고_입력은_안_바꾼다():
    calls = [
        {"id": "a", "type": "function", "function": {"name": "x", "arguments": "{}"}},
        {"id": "b", "type": "function", "function": {"name": "y", "arguments": "{}"}},
    ]
    messages = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": calls},
    ]
    out = solar._gemini_messages(messages)
    sig = out[1]["tool_calls"][0]["extra_content"]["google"]["thought_signature"]
    assert sig == solar._DUMMY_SIGNATURE
    assert "extra_content" not in out[1]["tool_calls"][1]  # 병렬 호출의 둘째는 서명이 없는 게 정상
    assert "extra_content" not in calls[0]  # 원본 불변


def test_진짜_서명이_있으면_건드리지_않는다():
    messages = [{"role": "assistant", "content": "", "tool_calls": [_SIG_CALL]}]
    out = solar._gemini_messages(messages)
    assert out[0]["tool_calls"][0]["extra_content"]["google"]["thought_signature"] == "REAL-SIG"


def test_도구_결과_직후_판단_호출에는_답을_쓰지_말라는_줄이_붙는다():
    msgs = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": [_SIG_CALL]},
        {"role": "tool", "tool_call_id": "call_1", "content": "{}"},
    ]
    out = solar._gemini_messages(msgs, judging=True)
    # system이 아니라 user여야 실제로 먹는다(실측) — 역할이 바뀌면 효과가 사라진다.
    assert out[-1] == {"role": "user", "content": solar._JUDGE_AFTER_TOOL_HINT}
    assert len(msgs) == 3  # 호출부 리스트는 안 바뀐다(루프가 같은 리스트를 계속 쓴다)
    # 첫 판단(마지막이 user)이나 생성 단계(judging 아님)에는 붙지 않는다.
    assert solar._gemini_messages(msgs[:1], judging=True) == msgs[:1]
    assert solar._gemini_messages(msgs, judging=False)[-1]["role"] == "tool"


async def test_판단_호출은_gemini에서_출력_상한이_낮다(monkeypatch, wire):
    """버려질 판단 텍스트가 512토큰을 채우던 낭비(실측 3~9초)를 자른다."""
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    rec = wire(_Recorder(_chat()))
    await solar.complete([{"role": "user", "content": "q"}], tools=[{"type": "function"}],
                         max_tokens=512)
    assert rec.body()["max_tokens"] == solar._GEMINI_JUDGE_MAX_TOKENS
    # tools가 없는 소형 호출은 호출부가 정한 값 그대로.
    await solar.complete([{"role": "user", "content": "q"}], max_tokens=300)
    assert rec.body()["max_tokens"] == 300


async def test_upstage_판단_호출의_상한은_그대로(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "upstage_api_key", UKEY)
    rec = wire(_Recorder(_chat()))
    await solar.complete([{"role": "user", "content": "q"}], tools=[{"type": "function"}],
                         max_tokens=512)
    assert rec.body()["max_tokens"] == 512
    assert "tools" in rec.body()


# --- 5. 사고 강도 ---------------------------------------------------------------

async def test_모델이_사고_강도를_거절하면_물러나고_기억한다(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    reject = httpx.Response(
        400,
        text='{"error":{"message":"Thinking level MINIMAL is not supported for this model."}}',
    )
    rec = wire(_Recorder(reject, _chat("ok"), _chat("ok2")))
    comp = await solar.complete([{"role": "user", "content": "q"}])
    assert comp.message["content"] == "ok"
    efforts = [json.loads(r.content).get("reasoning_effort") for r in rec.requests]
    assert efforts == ["minimal", "low"]
    # 기억했으므로 다음 호출은 처음부터 low — 400 왕복이 반복되지 않는다.
    await solar.complete([{"role": "user", "content": "q"}])
    assert len(rec.requests) == 3
    assert rec.body()["reasoning_effort"] == "low"


async def test_사고_강도_외의_400은_재시도하지_않는다(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    rec = wire(_Recorder(httpx.Response(400, text="Function call is missing a thought_signature")))
    with pytest.raises(RuntimeError):
        await solar.complete([{"role": "user", "content": "q"}])
    assert len(rec.requests) == 1


async def test_잘못된_강도_설정은_minimal로(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    monkeypatch.setattr(solar.settings, "gemini_reasoning_effort", "none")  # flash-lite가 거절
    rec = wire(_Recorder(_chat()))
    await solar.complete([{"role": "user", "content": "q"}])
    assert rec.body()["reasoning_effort"] == "minimal"


# --- 6. 스트리밍 · 추론 누출 -------------------------------------------------------

async def test_스트림은_content만_답이_되고_추론은_새지_않는다(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    rec = wire(
        _Recorder(
            _sse(
                _delta("CHAT: ", reasoning_content="먼저 생각해 보면 사용자가 광합성을…"),
                _delta("안녕", extra_content={"google": {"thought_signature": "SIG"}}),
                _delta(None, reasoning_content="추론 계속"),
                _delta("!\n@concept: 광합성 | 식물과 에너지"),
                {"choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": 7,
                                          "total_tokens": 40}},
                "[DONE]",
            )
        )
    )
    usage: dict[str, int] = {}
    out = "".join([d async for d in solar.stream_answer([], "q", "sys", usage_sink=usage)])
    assert out == "CHAT: 안녕!\n@concept: 광합성 | 식물과 에너지"
    assert "생각" not in out and "SIG" not in out and "추론" not in out
    # 파서가 이 답에서 분류 태그를 읽는다 — 형식 계약 유지.
    assert solar.extract_used_tags([{"answer": out}]) == ["식물과 에너지"]
    assert usage == {"prompt": 11, "completion": 7, "total": 40, "cached": 0}
    body = rec.body()
    assert body["stream"] is True
    assert body["stream_options"] == {"include_usage": True}
    assert body["reasoning_effort"] == "minimal"
    assert body["model"] == "gemini-3.5-flash"


async def test_스트림도_사고_강도_거절에서_물러난다(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    rec = wire(
        _Recorder(
            httpx.Response(400, text="Thinking level MINIMAL is not supported for this model."),
            _sse(_delta("안녕"), "[DONE]"),
        )
    )
    out = "".join([d async for d in solar.stream_answer([], "q", "sys")])
    assert out == "안녕"
    assert [json.loads(r.content)["reasoning_effort"] for r in rec.requests] == ["minimal", "low"]


async def test_upstage_스트림_경로는_옛_계약_그대로(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "upstage_api_key", UKEY)
    rec = wire(_Recorder(_sse(_delta("A"), _delta("B"), "[DONE]")))
    out = "".join([d async for d in solar.stream_answer([], "q", "sys")])
    assert out == "AB"
    assert str(rec.requests[0].url) == U_URL
    body = rec.body()
    assert body["model"] == "solar-pro3"
    assert "reasoning_effort" not in body
    assert "stream_options" not in body  # usage_sink가 없으면 안 보낸다(기존 동작)


# --- 7. 질문 코치 — 같은 경로를 탄다 ------------------------------------------------

async def test_질문_코치도_gemini_light_모델로_간다(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    rec = wire(_Recorder(_chat("주제: 광합성\n지금: 정의\n다음: 원인")))
    got = await question_coach._ask("1. 학생 질문: 광합성이 뭐야?", "solar-pro2")
    assert got.startswith("주제: 광합성")
    assert str(rec.requests[0].url) == G_URL
    body = rec.body()
    assert body["model"] == "gemini-3.5-flash-lite"
    assert body["max_tokens"] == 160
    assert body["temperature"] == 0.2
    assert body["messages"][0]["role"] == "system"


async def test_질문_코치_upstage_폴백은_옛_모델_이름을_쓴다(monkeypatch, wire):
    monkeypatch.setattr(solar.settings, "upstage_api_key", UKEY)
    rec = wire(_Recorder(_chat("중단: 끝")))
    await question_coach._ask("x", "solar-pro2")
    assert str(rec.requests[0].url) == U_URL
    assert rec.body()["model"] == "solar-pro2"
    await question_coach._ask("x", None)
    assert rec.body()["model"] == "solar-pro3"  # None → 전역 채팅 모델(기존 동작)


async def test_질문_코치는_키가_없으면_조용히_실패한다():
    """코치는 채팅을 막지 않는다 — analyse가 예외를 삼켜 None."""

    class _Client:
        async def select(self, *a, **k):
            return [{"id": "1", "title": "t", "body": "b", "data": {}}]

    got = await question_coach.analyse(_Client(), ["1"], model=None)
    assert got is None


# --- 8. 진단·표시 ---------------------------------------------------------------

def test_chat_env_configured는_둘_중_하나면_참(monkeypatch):
    assert api_keys.chat_env_configured() is False
    monkeypatch.setattr(api_keys.settings, "upstage_api_key", UKEY)
    assert api_keys.chat_env_configured() is True
    monkeypatch.setattr(api_keys.settings, "upstage_api_key", "")
    monkeypatch.setattr(api_keys.settings, "gemini_api_key", GKEY)
    assert api_keys.chat_env_configured() is True


def _health(monkeypatch, **kw):
    for k, v in kw.items():
        monkeypatch.setattr(H.settings, k, v)
    return TestClient(app).get("/health/config")


def test_health는_gemini만_있어도_chat이_구성됨이다(monkeypatch):
    r = _health(monkeypatch, gemini_api_key=GKEY, upstage_api_key="")
    chat = r.json()["chat"]
    assert chat["configured"] is True
    assert chat["provider"] == "gemini"
    assert chat["model"] == "gemini-3.5-flash"
    assert chat["light_model"] == "gemini-3.5-flash-lite"
    assert "chat" not in r.json()["blocking"]
    assert GKEY not in r.text  # 비밀 비노출


def test_health는_upstage만_있으면_옛_표시_그대로(monkeypatch):
    r = _health(monkeypatch, gemini_api_key="", upstage_api_key=UKEY,
                upstage_chat_model="solar-pro3")
    chat = r.json()["chat"]
    assert chat["configured"] is True
    assert chat["provider"] == "upstage"
    assert chat["model"] == "solar-pro3"
    assert chat["base_url"] == H.settings.upstage_base_url
    assert UKEY not in r.text


def test_health는_키가_둘_다_없으면_chat이_막힌다(monkeypatch):
    r = _health(monkeypatch, gemini_api_key="", upstage_api_key="")
    assert r.json()["chat"]["configured"] is False
    assert r.json()["chat"]["provider"] is None
    assert "chat" in r.json()["blocking"]


def test_콘솔과_로그가_보는_활성_모델(monkeypatch, header_keys):
    assert solar.active_chat_model() == "solar-pro3"  # 키 없음 — 폴백이 될 모델
    monkeypatch.setattr(solar.settings, "upstage_api_key", UKEY)
    assert solar.active_provider() == "upstage"
    assert solar.active_chat_model() == "solar-pro3"
    monkeypatch.setattr(solar.settings, "gemini_api_key", GKEY)
    assert solar.active_provider() == "gemini"
    assert solar.active_chat_model() == "gemini-3.5-flash"
    assert solar.active_chat_model("solar-pro2") == "gemini-3.5-flash-lite"
