"""D171 — 손글씨 OCR 클라이언트 + 창구.

외부 호출 없음: `httpx.MockTransport`로 VARCO 서버를 흉내 낸다.

검증 관점 셋:

1. **주소 유도** — OCR_BASE_URL이 비면 JUDGE_BASE_URL의 호스트에 포트를 갈아
   끼운다(사용자 지시 2026-08-04). 여기가 틀리면 요청이 비전 엔드포인트나
   남의 서비스로 날아가는데, 화면에는 "인식 못 함"으로만 보인다.
2. **미설정과 고장이 갈린다** — 501(아직 없음) vs 502(있는데 안 받음). 프론트
   문구가 이 둘로 갈리므로 코드가 뭉개지면 안내가 거짓이 된다.
3. **빈 결과는 오류가 아니다** — 아무것도 못 읽은 것은 학생 잘못이 아니다.
"""

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth.deps import CurrentUser, get_current_user
from app.main import app
from app.routers import ocr as R
from app.services import ocr as S

# TestClient를 context manager로 쓰지 않는다(test_health_config와 같은 이유 —
# lifespan이 돌면 Qdrant 접속·워커 기동이 일어난다).
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


@pytest.fixture(autouse=True)
def _endpoint(monkeypatch):
    """기본 상태: judge만 설정돼 있고 OCR 주소는 비어 있다(= 유도 경로)."""
    monkeypatch.setattr(S.settings, "ocr_enabled", True)
    monkeypatch.setattr(S.settings, "ocr_base_url", "")
    monkeypatch.setattr(S.settings, "ocr_port", 30020)
    monkeypatch.setattr(S.settings, "judge_base_url", "http://10.0.0.9:30119/v1")


@pytest.fixture
def as_student():
    """로그인 통과 — 이 창구는 GPU 앞의 문이라 인증이 계약의 일부다."""
    user = CurrentUser(
        id="00000000-0000-0000-0000-000000000001", email="s@nodi.test", role="student"
    )
    app.dependency_overrides[get_current_user] = lambda: user
    yield
    app.dependency_overrides.clear()


def _mock(handler):
    """S.recognize가 쓰는 AsyncClient를 MockTransport로 갈아 끼운다."""
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    return factory


# --- 주소 유도 -------------------------------------------------------------

def test_주소는_judge_호스트에서_유도된다():
    """포트만 갈아 끼우고 /v1 경로는 뗀다 — VARCO는 루트에 /ocr을 연다."""
    assert S.resolve_base_url() == "http://10.0.0.9:30020"


def test_명시한_주소가_유도를_이긴다(monkeypatch):
    """다른 기계로 옮긴 경우. 끝의 슬래시는 정리한다(f-string으로 /ocr을 붙인다)."""
    monkeypatch.setattr(S.settings, "ocr_base_url", "http://127.0.0.1:8083/")
    assert S.resolve_base_url() == "http://127.0.0.1:8083"


def test_judge도_비면_추측하지_않는다(monkeypatch):
    """D97과 같은 방침 — 기본값이 엉뚱한 서비스를 가리키면 요청이 남의 집으로 간다."""
    monkeypatch.setattr(S.settings, "judge_base_url", "")
    assert S.resolve_base_url() == ""
    assert S.missing_config() == ["OCR_BASE_URL"]
    assert not S.is_configured()


def test_꺼두면_미설정으로_본다(monkeypatch):
    monkeypatch.setattr(S.settings, "ocr_enabled", False)
    assert "OCR_ENABLED" in S.missing_config()


# --- 호출 ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_recognize_는_multipart로_보내고_text만_쓴다(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.content
        return httpx.Response(
            200,
            json={
                "text": "빛의  굴절이\n뭐야?",
                "boxes": [{"text": "빛의", "bbox": [0.0, 0.0, 0.1, 0.1]}],
                "elapsed_sec": 6.5,
            },
        )

    monkeypatch.setattr(S.httpx, "AsyncClient", _mock(handler))
    text = await S.recognize(PNG)

    assert seen["url"] == "http://10.0.0.9:30020/ocr"
    assert b"handwriting.png" in seen["body"]
    assert b"max_new_tokens" in seen["body"]
    # 공백·줄바꿈은 하나로 모으되 글자는 고치지 않는다.
    assert text == "빛의 굴절이 뭐야?"


@pytest.mark.asyncio
async def test_연결이_안_되면_상류_오류(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(S.httpx, "AsyncClient", _mock(handler))
    with pytest.raises(S.OcrUpstreamError):
        await S.recognize(PNG)


@pytest.mark.asyncio
async def test_text가_없으면_조용히_넘기지_않는다(monkeypatch):
    """계약이 바뀌었거나 다른 서비스를 가리키는 상태. 빈 문자열로 뭉개면
    화면에 '알아보지 못했어요'로만 보여 원인을 못 찾는다."""
    monkeypatch.setattr(
        S.httpx, "AsyncClient", _mock(lambda r: httpx.Response(200, json={"boxes": []}))
    )
    with pytest.raises(S.OcrUpstreamError):
        await S.recognize(PNG)


@pytest.mark.asyncio
async def test_미설정이면_부르기_전에_멈춘다(monkeypatch):
    monkeypatch.setattr(S.settings, "judge_base_url", "")
    with pytest.raises(S.OcrUnavailable):
        await S.recognize(PNG)


# --- 창구 ------------------------------------------------------------------

def test_인증_없이는_못_부른다():
    r = TestClient(app).post("/api/ocr/handwriting", files={"image": ("a.png", PNG, "image/png")})
    assert r.status_code in (401, 403)


def test_미설정은_501이다(monkeypatch, as_student):
    """프론트가 404/501을 '준비하고 있어요' 한 문구로 모은다 — 라우터가 없던
    시절과 같은 화면이 된다."""
    monkeypatch.setattr(S.settings, "judge_base_url", "")
    r = TestClient(app).post(
        "/api/ocr/handwriting", files={"image": ("a.png", PNG, "image/png")}
    )
    assert r.status_code == 501


def test_상류_고장은_502다(monkeypatch, as_student):
    """미설정과 갈라야 한다 — 이쪽은 '잠시 안 돼요'로 안내된다."""
    monkeypatch.setattr(
        S.httpx, "AsyncClient", _mock(lambda r: httpx.Response(500, text="boom"))
    )
    r = TestClient(app).post(
        "/api/ocr/handwriting", files={"image": ("a.png", PNG, "image/png")}
    )
    assert r.status_code == 502


def test_성공_응답_형태(monkeypatch, as_student):
    monkeypatch.setattr(
        S.httpx,
        "AsyncClient",
        _mock(lambda r: httpx.Response(200, json={"text": "미터원기가 뭐야?"})),
    )
    r = TestClient(app).post(
        "/api/ocr/handwriting",
        files={"image": ("a.png", PNG, "image/png")},
        data={"lang": "ko"},
    )
    assert r.status_code == 200
    # confidence는 계약에만 있고 늘 비어 있다 — VARCO는 점수를 주지 않는다.
    assert r.json() == {"text": "미터원기가 뭐야?", "confidence": None}


def test_아무것도_못_읽어도_200이다(monkeypatch, as_student):
    """4xx를 주면 학생 잘못처럼 보인다. 화면이 '다시 써 볼까요'로 안내한다."""
    monkeypatch.setattr(
        S.httpx, "AsyncClient", _mock(lambda r: httpx.Response(200, json={"text": "   "}))
    )
    r = TestClient(app).post(
        "/api/ocr/handwriting", files={"image": ("a.png", PNG, "image/png")}
    )
    assert r.status_code == 200 and r.json()["text"] == ""


def test_너무_큰_그림은_413(monkeypatch, as_student):
    monkeypatch.setattr(R.settings, "ocr_max_image_bytes", 128)
    r = TestClient(app).post(
        "/api/ocr/handwriting", files={"image": ("a.png", b"x" * 200, "image/png")}
    )
    assert r.status_code == 413


def test_빈_그림은_422(as_student):
    r = TestClient(app).post(
        "/api/ocr/handwriting", files={"image": ("a.png", b"", "image/png")}
    )
    assert r.status_code == 422
