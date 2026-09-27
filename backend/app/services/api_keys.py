"""외부 API 키 해석 — `.env` 우선, 없으면 요청 헤더 (공개판 C 분류).

## 규칙

1. `.env`에 키가 있으면 **그 키만** 쓴다. 헤더로 온 키는 무시한다 — 운영자가
   키를 넣어 둔 서버에서 방문자가 자기 키로 바꿔 칠 이유가 없다.
2. `.env`가 비어 있으면 브라우저가 요청마다 헤더로 실어 보낸 키를 쓴다.
   - `X-Upstage-Key`  대화 생성·질의 임베딩·질문 코치
   - `X-Gemini-Key`   비전(도판 캡션·손글씨·펜 표시 해석)
   - `X-Gemini-Model` 비전 모델 선택(허용 목록 안에서만)
3. 헤더 키는 **이 요청의 수명 동안 메모리(ContextVar)에만** 있다. DB·파일·로그
   어디에도 쓰지 않는다. 요청이 끝나면 미들웨어가 되돌린다.

## 백그라운드 워커는 헤더를 못 본다

업로드 파싱·임베딩·도판 캡션은 요청이 끝난 뒤 워커가 돈다. 그 시점엔 헤더가
없으므로 `.env` 키로만 동작한다(사용자 결정 2026-09-27: 업로드는 .env 키 전용).
그래서 `upload_enabled()`는 헤더를 보지 않는다.

## 프론트가 아는 것

`GET /api/config`가 `.env` 설정 여부만 true/false로 내려준다. 키 값은 절대
응답에 싣지 않는다(routers/health.py `public_config`).
"""

from __future__ import annotations

from contextvars import ContextVar

from ..config import get_settings

settings = get_settings()

UPSTAGE_HEADER = "x-upstage-key"
GEMINI_HEADER = "x-gemini-key"
GEMINI_MODEL_HEADER = "x-gemini-model"

# 비전 모델 허용 목록 (2026-09-27 공식 모델 목록에서 확인한 stable 모델).
# Pro 계열은 넣지 않는다 — 캡션·손글씨는 가벼운 모델로 충분하다(사용자 지시).
# 헤더로 임의 문자열을 받아 URL 경로에 넣지 않도록 여기서 거른다.
GEMINI_VISION_MODELS: tuple[str, ...] = (
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
)
DEFAULT_GEMINI_MODEL = GEMINI_VISION_MODELS[0]

_upstage_key: ContextVar[str] = ContextVar("upstage_key", default="")
_gemini_key: ContextVar[str] = ContextVar("gemini_key", default="")
_gemini_model: ContextVar[str] = ContextVar("gemini_model", default="")


# --- .env 설정 여부 (프론트 UI 분기용) ----------------------------------------
def upstage_env_configured() -> bool:
    return bool(settings.upstage_api_key.strip())


def gemini_env_configured() -> bool:
    return bool(settings.gemini_api_key.strip())


def upload_enabled() -> bool:
    """업로드(파싱·임베딩 워커)는 .env 키로만 돈다 — 헤더 키는 워커에 닿지 않는다."""
    return upstage_env_configured()


# --- 실제 호출에 쓸 키 --------------------------------------------------------
def upstage_key() -> str:
    """이번 호출에 쓸 Upstage 키. 없으면 빈 문자열(호출부가 503/비활성 처리)."""
    return settings.upstage_api_key.strip() or _upstage_key.get()


def gemini_key() -> str:
    return settings.gemini_api_key.strip() or _gemini_key.get()


def gemini_model() -> str:
    """비전 모델. .env 키가 있으면 .env 모델, 아니면 헤더 선택값(허용 목록)."""
    if gemini_env_configured():
        return settings.gemini_vision_model.strip() or DEFAULT_GEMINI_MODEL
    chosen = _gemini_model.get()
    return chosen if chosen in GEMINI_VISION_MODELS else DEFAULT_GEMINI_MODEL


# --- 요청 범위 바인딩 ---------------------------------------------------------
class RequestKeysMiddleware:
    """헤더의 키를 요청 수명 동안만 ContextVar에 묶는 순수 ASGI 미들웨어.

    BaseHTTPMiddleware가 아니라 순수 ASGI로 쓴 이유: SSE 스트림은 응답 본문을
    내보내는 동안에도 LLM을 부른다. 순수 ASGI는 `await self.app(...)`이 스트림
    끝까지 이 컨텍스트 안에서 돌아서 키가 끝까지 보인다.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        found: dict[str, str] = {}
        for raw_name, raw_value in scope.get("headers") or []:
            name = raw_name.decode("latin-1").lower()
            if name in (UPSTAGE_HEADER, GEMINI_HEADER, GEMINI_MODEL_HEADER):
                found[name] = raw_value.decode("latin-1").strip()[:512]
        tokens = (
            _upstage_key.set(found.get(UPSTAGE_HEADER, "")),
            _gemini_key.set(found.get(GEMINI_HEADER, "")),
            _gemini_model.set(found.get(GEMINI_MODEL_HEADER, "")),
        )
        try:
            await self.app(scope, receive, send)
        finally:
            _upstage_key.reset(tokens[0])
            _gemini_key.reset(tokens[1])
            _gemini_model.reset(tokens[2])
