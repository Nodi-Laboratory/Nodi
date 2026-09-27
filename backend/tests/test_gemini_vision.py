"""공개판 Gemini 비전 — 전송 계약 + 제공자 우선순위 (사용자 결정 2026-09-27).

외부 호출 없음: `httpx.MockTransport`로 generateContent를 흉내 낸다.

검증 관점:

1. **키는 헤더로만 간다** — URL(쿼리)에 실리면 예외 문자열·프록시 로그에 그대로
   찍힌다. 오류 메시지에도 키가 없어야 한다.
2. **모델은 허용 목록 안에서만** — 헤더로 온 임의 문자열이 URL 경로에 들어가지 않는다.
3. **차단·빈 응답은 빈 문자열** — 지어내지 않는다(D134·D181). 호출부가 빈 값을
   "못 읽음"/"캡션 실패"로 다룬다.
4. **우선순위** — Gemini > 자체 호스팅(legacy) > 없음. 운영(대회) 배포는 Gemini
   없이 legacy로 돌아야 하므로 legacy 갈래가 살아 있음을 함께 고정한다.
"""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth.deps import CurrentUser, get_current_user
from app.main import app
from app.services import (
    api_keys,
    figure_caption,
    figure_judge,
    gemini_vision,
    handwriting_vision,
    ink_marks,
)
from app.services import ocr as ocr_svc

KEY = "AIza-TEST-SECRET-KEY"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def _ok(text: str, **extra) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "candidates": [
                {"content": {"parts": [{"text": text}], "role": "model"},
                 "finishReason": "STOP", **extra}
            ]
        },
    )


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    """기본 상태: Gemini .env 키 없음, legacy도 없음, 헤더 키 없음."""
    s = gemini_vision.settings
    monkeypatch.setattr(s, "gemini_api_key", "")
    monkeypatch.setattr(s, "gemini_vision_model", "gemini-3.5-flash-lite")
    monkeypatch.setattr(s, "gemini_base_url", "https://gemini.test/v1beta")
    monkeypatch.setattr(s, "judge_api_key", "")
    monkeypatch.setattr(s, "judge_base_url", "")
    monkeypatch.setattr(s, "judge_model", "EXAONE-4.5-33B")
    monkeypatch.setattr(s, "ocr_base_url", "")
    monkeypatch.setattr(s, "ocr_enabled", True)

    async def overlay():
        return {}

    monkeypatch.setattr(ink_marks.app_settings, "get_overlay", overlay)
    yield


@pytest.fixture
def header_key():
    """앱에서 입력한 키(요청 헤더 → ContextVar)를 흉내 낸다."""
    tokens = []

    def _bind(key: str = KEY, model: str = ""):
        tokens.append((api_keys._gemini_key, api_keys._gemini_key.set(key)))
        tokens.append((api_keys._gemini_model, api_keys._gemini_model.set(model)))

    yield _bind
    for var, tok in reversed(tokens):
        try:
            var.reset(tok)
        except ValueError:
            # async 테스트는 다른 Context에서 set된다 — 그 Context는 이미 버려졌다.
            var.set("")


# --- 전송 계약 -----------------------------------------------------------------

async def test_키는_헤더로만_가고_URL에는_없다(monkeypatch):
    monkeypatch.setattr(gemini_vision.settings, "gemini_api_key", KEY)
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["key"] = req.headers.get("x-goog-api-key")
        seen["body"] = json.loads(req.content)
        return _ok("안녕")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await gemini_vision.generate(
            [gemini_vision.image_part(b"img"), {"text": "옮겨 적어라"}],
            system="너는 전사 도우미다",
            max_output_tokens=123,
            client=c,
        )
    assert got == "안녕"
    assert KEY not in seen["url"] and "key=" not in seen["url"]
    assert seen["key"] == KEY
    assert seen["url"] == (
        "https://gemini.test/v1beta/models/gemini-3.5-flash-lite:generateContent"
    )
    body = seen["body"]
    assert body["systemInstruction"] == {"parts": [{"text": "너는 전사 도우미다"}]}
    parts = body["contents"][0]["parts"]
    assert parts[0]["inline_data"]["mime_type"] == "image/png"
    assert parts[1] == {"text": "옮겨 적어라"}
    cfg = body["generationConfig"]
    assert cfg["maxOutputTokens"] == 123
    # 3.x는 sampling 조정을 권하지 않는다 — 기본은 안 보낸다.
    assert "temperature" not in cfg
    assert cfg["thinkingConfig"] == {"thinkingLevel": "minimal"}


async def test_오류_메시지에_키가_없다(monkeypatch):
    monkeypatch.setattr(gemini_vision.settings, "gemini_api_key", KEY)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"message": "API key not valid"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(gemini_vision.GeminiError) as ei:
            await gemini_vision.generate([{"text": "x"}], client=c)
    assert ei.value.status == 403 and not ei.value.busy
    assert KEY not in str(ei.value)


async def test_429는_붐빔이다(monkeypatch):
    monkeypatch.setattr(gemini_vision.settings, "gemini_api_key", KEY)
    transport = httpx.MockTransport(lambda r: httpx.Response(429, json={}))
    async with httpx.AsyncClient(transport=transport) as c:
        with pytest.raises(gemini_vision.GeminiError) as ei:
            await gemini_vision.generate([{"text": "x"}], client=c)
    assert ei.value.busy


async def test_400이면_thinking_없이_한_번만_다시_보낸다(monkeypatch):
    monkeypatch.setattr(gemini_vision.settings, "gemini_api_key", KEY)
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        if len(bodies) == 1:
            return httpx.Response(400, json={"error": {"message": "bad level"}})
        return _ok("됐다")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        assert await gemini_vision.generate([{"text": "x"}], client=c) == "됐다"
    assert len(bodies) == 2
    assert "thinkingConfig" in bodies[0]["generationConfig"]
    assert "thinkingConfig" not in bodies[1]["generationConfig"]


async def test_키가_없으면_부르지_않는다():
    with pytest.raises(gemini_vision.GeminiError):
        await gemini_vision.generate([{"text": "x"}])


@pytest.mark.parametrize(
    "payload",
    [
        {"promptFeedback": {"blockReason": "SAFETY"}},
        {"candidates": []},
        {"candidates": [{"finishReason": "SAFETY"}]},
        {"candidates": [{"content": {"parts": []}, "finishReason": "MAX_TOKENS"}]},
        {"candidates": [{"content": {"parts": [{"text": "생각 중", "thought": True}]}}]},
        [],
    ],
)
def test_차단_빈_응답은_빈_문자열(payload):
    assert gemini_vision.extract_text(payload) == ""


def test_사고_요약은_버리고_본문만_잇는다():
    data = {"candidates": [{"content": {"parts": [
        {"text": "고민", "thought": True}, {"text": "미터"}, {"text": "원기"},
    ]}}]}
    assert gemini_vision.extract_text(data) == "미터원기"


def test_openai_메시지를_순서대로_변환한다():
    uri = figure_judge.image_data_uri(b"abc", "jpg")
    parts = gemini_vision.parts_from_openai_content([
        {"type": "image_url", "image_url": {"url": uri}},
        {"type": "image_url", "image_url": {"url": "https://remote/x.png"}},
        {"type": "text", "text": "지시"},
    ])
    assert parts[0]["inline_data"]["mime_type"] == "image/jpeg"
    assert parts[0]["inline_data"]["data"] == "YWJj"
    # 원격 URL은 싣지 않는다.
    assert parts[1] == {"text": "지시"} and len(parts) == 2


# --- 모델 허용 목록 ------------------------------------------------------------

def test_헤더_모델은_허용_목록_안에서만(header_key):
    header_key(KEY, "gemini-9-ultra-pro")
    assert api_keys.gemini_model() == api_keys.DEFAULT_GEMINI_MODEL


def test_허용된_헤더_모델은_따른다(header_key):
    header_key(KEY, "gemini-3.5-flash")
    assert api_keys.gemini_model() == "gemini-3.5-flash"


def test_env_키가_있으면_헤더_키와_모델을_무시한다(monkeypatch, header_key):
    monkeypatch.setattr(gemini_vision.settings, "gemini_api_key", "ENV-KEY")
    monkeypatch.setattr(gemini_vision.settings, "gemini_vision_model", "gemini-3.1-flash-lite")
    header_key("HEADER-KEY", "gemini-3.6-flash")
    assert api_keys.gemini_key() == "ENV-KEY"
    assert api_keys.gemini_model() == "gemini-3.1-flash-lite"


# --- 제공자 우선순위 -----------------------------------------------------------

def test_아무것도_없으면_None():
    assert gemini_vision.pick_provider(legacy_ok=False) is None
    assert figure_judge.provider() is None and not figure_judge.is_configured()
    assert ink_marks.provider() is None and not ink_marks.is_configured()


def test_legacy만_있으면_legacy다(monkeypatch):
    """운영(대회) 배포 모양 — Gemini 키 없이 EXAONE으로 돌아야 한다."""
    s = gemini_vision.settings
    monkeypatch.setattr(s, "judge_api_key", "k")
    monkeypatch.setattr(s, "judge_base_url", "http://judge.test/v1")
    assert figure_judge.provider() == "legacy"
    assert ink_marks.provider() == "legacy"


def test_gemini가_legacy보다_먼저다(monkeypatch):
    s = gemini_vision.settings
    monkeypatch.setattr(s, "judge_api_key", "k")
    monkeypatch.setattr(s, "judge_base_url", "http://judge.test/v1")
    monkeypatch.setattr(s, "gemini_api_key", KEY)
    assert figure_judge.provider() == "gemini"
    assert ink_marks.provider() == "gemini"
    assert figure_judge.missing_config() == []  # legacy도 채워져 있다


def test_도판_캡션은_헤더_키로_켜지지_않는다(header_key):
    """워커는 헤더를 못 본다 — 요청 중에 '된다'고 하면 업로드 뒤 전량 실패한다."""
    header_key()
    assert figure_judge.provider() is None
    # 요청 경로 기능(펜 표시)은 헤더 키로 켜진다.
    assert ink_marks.provider() == "gemini"


# --- 기능별 전송 교체 ----------------------------------------------------------

async def test_도판_캡션이_gemini로_간다(monkeypatch):
    monkeypatch.setattr(gemini_vision.settings, "gemini_api_key", KEY)
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        return _ok("  첨성대 사진.\t경주에 있다. ")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await figure_caption.caption_one(c, "본문", "첨성대", "", b"img", "png")
    assert got == "첨성대 사진. 경주에 있다."
    assert "gemini.test" in seen["url"]
    text = seen["body"]["contents"][0]["parts"][-1]["text"]
    assert "첨성대" in text and "페이지 본문" in text  # 프롬프트는 그대로다


async def test_도판_캡션_빈_응답은_재시도_후_실패(monkeypatch):
    monkeypatch.setattr(gemini_vision.settings, "gemini_api_key", KEY)
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(ValueError):
            await figure_caption.caption_one(c, "본문", "", "", b"img", "png")
    assert len(calls) == 2


async def test_펜_표시_해석이_gemini로_간다(header_key):
    header_key()
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        return _ok("설명: 화살표가 [카드 2]를 가리킨다.")

    cards = [{"n": 2, "title": "천문학", "where": "위"}]
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        got = await ink_marks.read_marks(cards, b"png", client=c)
    assert got.status == "ok"
    assert got.note == "화살표가 [카드 2]를 가리킨다."
    assert seen["url"].startswith("https://gemini.test/")


async def test_손글씨_gemini는_실패를_올린다(monkeypatch, header_key):
    header_key()
    monkeypatch.setattr(
        gemini_vision.httpx, "AsyncClient", _mock(lambda r: httpx.Response(500, json={}))
    )
    with pytest.raises(gemini_vision.GeminiError):
        await handwriting_vision.recognize_gemini(PNG)


# --- 창구 ----------------------------------------------------------------------

def _mock(handler):
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    return factory


@pytest.fixture
def as_student():
    user = CurrentUser(
        id="00000000-0000-0000-0000-000000000001", email="s@nodi.test", role="student"
    )
    app.dependency_overrides[get_current_user] = lambda: user
    yield
    app.dependency_overrides.clear()


def _post_ocr(headers=None):
    return TestClient(app).post(
        "/api/ocr/handwriting",
        files={"image": ("a.png", PNG, "image/png")},
        headers=headers or {},
    )


def test_둘_다_없으면_501이고_키_입력을_안내한다(as_student):
    r = _post_ocr()
    assert r.status_code == 501
    assert "GEMINI_API_KEY" in r.json()["detail"]


def test_앱에서_넣은_키로_읽고_VARCO는_안_부른다(monkeypatch, as_student):
    # VARCO도 설정돼 있지만 Gemini가 먼저다.
    monkeypatch.setattr(ocr_svc.settings, "ocr_base_url", "http://varco.test")
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.setdefault("hosts", []).append(req.url.host)
        seen["key"] = req.headers.get("x-goog-api-key")
        return _ok("미터원기가 뭐야?")

    monkeypatch.setattr(gemini_vision.httpx, "AsyncClient", _mock(handler))
    r = _post_ocr({"X-Gemini-Key": KEY})
    assert r.status_code == 200
    assert r.json() == {"text": "미터원기가 뭐야?", "confidence": None}
    assert seen["hosts"] == ["gemini.test"] and seen["key"] == KEY


@pytest.mark.parametrize("code,expected", [(429, 503), (500, 502)])
def test_gemini_실패는_VARCO와_같은_갈래(monkeypatch, as_student, code, expected):
    monkeypatch.setattr(
        gemini_vision.httpx, "AsyncClient", _mock(lambda r: httpx.Response(code, json={}))
    )
    r = _post_ocr({"X-Gemini-Key": KEY})
    assert r.status_code == expected
    assert KEY not in r.text


def test_gemini가_못_읽으면_200_빈_글자(monkeypatch, as_student):
    monkeypatch.setattr(
        gemini_vision.httpx, "AsyncClient",
        _mock(lambda r: _ok("글씨를 읽을 수 없습니다.")),
    )
    r = _post_ocr({"X-Gemini-Key": KEY})
    assert r.status_code == 200 and r.json()["text"] == ""


def test_펜_창구는_gemini로_읽었다고_남긴다(monkeypatch, as_student):
    monkeypatch.setattr(
        gemini_vision.httpx, "AsyncClient", _mock(lambda r: _ok("이게 뭐야"))
    )
    r = TestClient(app).post(
        "/api/ink/interpret",
        files={"ink_png": ("a.png", PNG, "image/png")},
        headers={"X-Gemini-Key": KEY},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "이게 뭐야"
    assert body["text_source"] == "gemini"
    assert body["marks_status"] == "no_scene"


def test_펜_창구도_둘_다_없으면_501(as_student):
    r = TestClient(app).post(
        "/api/ink/interpret", files={"ink_png": ("a.png", PNG, "image/png")}
    )
    assert r.status_code == 501


def test_health에_gemini_블록이_있고_키는_없다(monkeypatch):
    monkeypatch.setattr(gemini_vision.settings, "gemini_api_key", KEY)
    r = TestClient(app).get("/health/config")
    assert KEY not in r.text
    d = r.json()
    assert d["gemini"]["env_key_set"] is True
    assert d["gemini"]["model"] == "gemini-3.5-flash-lite"
    assert d["judge"]["configured"] is True and d["judge"]["provider"] == "gemini"
    assert d["judge"]["missing"] == []
    assert d["ocr"]["configured"] is True and d["ocr"]["provider"] == "gemini"
