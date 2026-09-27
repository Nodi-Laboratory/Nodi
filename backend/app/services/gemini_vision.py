"""Gemini 비전 호출 — 도판 캡션·손글씨 전사·펜 표시 해석의 1순위 창구 (공개판).

사용자 결정(2026-09-27): "비전 모델, 손글씨 인식 모두 gemini api로 수행. 너무
높은 모델을 사용하지 않도록." 키·모델 해석은 `api_keys`가 한다(.env 우선, 없으면
요청 헤더). 이 모듈은 **전송만** 한다 — 프롬프트는 각 기능 모듈(figure_caption·
handwriting_vision·ink_marks)이 그대로 소유한다.

## 제공자 우선순위 (세 기능 공통 — `pick_provider`)

1. **Gemini** — 키가 있으면(.env 또는 헤더) 언제나 이쪽.
2. **자체 호스팅(legacy)** — Gemini가 없고 JUDGE_*/OCR_*가 채워졌을 때만.
   운영 배포는 대회 규정상 제품 안에서 해외 모델을 쓸 수 없어(deploy/deploy.sh)
   Gemini 키 없이 EXAONE·VARCO로 돈다 — 이 갈래가 사라지면 운영이 죽는다.
3. **없음** — 기능별로 조용히 비활성(501·no-caption·표시 해석 생략). 앱은 안 죽는다.

Gemini가 설정돼 있는데 호출이 실패해도 legacy로 **넘어가지 않는다** — 공개판에서
legacy는 대개 비어 있고, 둘 다 설정된 환경에서 조용히 다른 모델로 바뀌면 품질
변화를 아무도 모른다(ink.py text_source와 같은 교훈).

## REST 계약 (2026-09-27 공식 문서 확인)

`POST {base}/models/{model}:generateContent`, 인증은 **`x-goog-api-key` 헤더**.
키를 쿼리(`?key=`)에 넣지 않는다 — URL은 httpx 예외 문자열·프록시 로그·트레이스에
그대로 찍힌다. 같은 이유로 키는 로그·예외 메시지 어디에도 싣지 않는다.

- 3.x 모델은 temperature/top_p 조정을 권하지 않는다(문서: "Do not configure
  temperature…"). 그래서 기본은 **안 보낸다**(`temperature=None`).
- thinking은 3.x에서 완전히 끌 수 없고 최저가 `minimal`이다. 전사·캡션은 추론이
  필요 없는 일이라 `thinkingConfig.thinkingLevel="minimal"`을 보낸다. 모델이
  그 값을 안 받으면(400) thinkingConfig 없이 **한 번만** 다시 보낸다 — 허용 목록
  모델마다 지원 수준이 다를 수 있고, 여기서 전부 실패하는 것보다 기본 수준으로
  도는 게 낫다.
- 응답 parts 중 `thought: true`는 사고 요약이라 버리고 text만 잇는다.
- 안전 차단(promptFeedback.blockReason)·빈 후보는 **빈 문자열**이다. 호출부가
  이미 빈 값을 "못 읽음"/"캡션 실패"로 다룬다 — 지어내지 않는다(D134·D181).
"""

from __future__ import annotations

import base64
import logging
from typing import Any

import httpx

from ..config import get_settings
from . import api_keys

logger = logging.getLogger("nodi.gemini_vision")
settings = get_settings()

#: 전사·캡션에는 추론이 필요 없다 — 3.x에서 고를 수 있는 가장 낮은 수준.
THINKING_LEVEL = "minimal"

#: 응답 오류 메시지 절단 상한 — 진단엔 충분하고 로그를 덮지 않는다.
_ERR_LIMIT = 200


class GeminiError(RuntimeError):
    """Gemini가 요청을 못 받았다(전송 실패·HTTP 오류). 메시지에 키는 없다."""

    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status

    @property
    def busy(self) -> bool:
        """429(쿼터·속도 제한) — 고장이 아니라 **잠깐 기다려야 함**(D177의 503 갈래)."""
        return self.status == 429


# --- 설정 게이트 ---------------------------------------------------------------
def is_configured() -> bool:
    """이번 요청에서 Gemini를 부를 수 있나 (.env 키 또는 헤더 키)."""
    return bool(api_keys.gemini_key())


def pick_provider(*, legacy_ok: bool, env_only: bool = False) -> str | None:
    """"gemini" · "legacy" · None — 우선순위는 모듈 머리말 그대로.

    `env_only`: 백그라운드 워커 경로(도판 캡션)용. 워커는 요청 헤더를 못 보므로
    요청 중에 헤더 키로 "된다"고 판정하면 업로드 뒤 워커에서 전부 실패한다.
    """
    gemini_ok = api_keys.gemini_env_configured() if env_only else is_configured()
    if gemini_ok:
        return "gemini"
    return "legacy" if legacy_ok else None


# --- 요청 조립 -----------------------------------------------------------------
def image_part(image_bytes: bytes, mime: str = "image/png") -> dict[str, Any]:
    return {
        "inline_data": {
            "mime_type": mime,
            "data": base64.b64encode(image_bytes).decode(),
        }
    }


def parts_from_openai_content(content: Any) -> list[dict[str, Any]]:
    """OpenAI 호환 user content → Gemini parts (순서 보존).

    기능 모듈들이 legacy 경로용으로 이미 `[{type:image_url, data URI}, {type:text}]`
    를 만든다. 프롬프트를 두 벌 두지 않으려고 **그 메시지를 그대로 변환**한다 —
    그림 먼저·지시 나중이라는 실측 순서(ink_marks 2026-08-05)도 함께 따라온다.
    """
    if isinstance(content, str):
        return [{"text": content}]
    parts: list[dict[str, Any]] = []
    for item in content or []:
        kind = item.get("type")
        if kind == "text":
            parts.append({"text": item.get("text") or ""})
        elif kind == "image_url":
            url = (item.get("image_url") or {}).get("url") or ""
            head, sep, data = url.partition(",")
            if not sep or not head.startswith("data:") or ";base64" not in head:
                continue  # 원격 URL은 싣지 않는다 — 우리는 늘 바이트를 가진다
            mime = head[len("data:"):].split(";", 1)[0] or "image/png"
            parts.append({"inline_data": {"mime_type": mime, "data": data}})
    return parts


def build_body(
    parts: list[dict[str, Any]],
    *,
    system: str | None,
    max_output_tokens: int,
    temperature: float | None,
    thinking: bool,
) -> dict[str, Any]:
    config: dict[str, Any] = {"maxOutputTokens": max_output_tokens}
    if temperature is not None:
        config["temperature"] = temperature
    if thinking:
        config["thinkingConfig"] = {"thinkingLevel": THINKING_LEVEL}
    body: dict[str, Any] = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": config,
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    return body


def extract_text(data: Any) -> str:
    """응답 JSON → 본문 텍스트. 차단·빈 후보·형식 이탈은 전부 ''."""
    if not isinstance(data, dict):
        return ""
    block = (data.get("promptFeedback") or {}).get("blockReason")
    if block:
        logger.info("Gemini가 입력을 차단했다(blockReason=%s) — 빈 결과로 처리", block)
        return ""
    candidates = data.get("candidates") or []
    if not candidates or not isinstance(candidates[0], dict):
        return ""
    cand = candidates[0]
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(
        p.get("text") or ""
        for p in parts
        if isinstance(p, dict) and not p.get("thought")
    )
    if not text.strip():
        logger.info(
            "Gemini 응답에 본문이 없다(finishReason=%s) — 빈 결과로 처리",
            cand.get("finishReason"),
        )
        return ""
    return text


def _error_message(resp: httpx.Response) -> str:
    try:
        msg = (resp.json().get("error") or {}).get("message") or ""
    except (ValueError, AttributeError):
        msg = ""
    return f"Gemini HTTP {resp.status_code}: {str(msg)[:_ERR_LIMIT]}".rstrip(": ")


# --- 호출 ----------------------------------------------------------------------
async def generate(
    parts: list[dict[str, Any]],
    *,
    system: str | None = None,
    max_output_tokens: int = 512,
    temperature: float | None = None,
    timeout: float | httpx.Timeout = 60.0,
    client: httpx.AsyncClient | None = None,
) -> str:
    """generateContent 1회 → 텍스트('' = 차단·빈 응답). 전송·HTTP 실패는 GeminiError.

    `client`를 주면 그것을 쓴다(figure_caption·ink_marks와 같은 규약 — 테스트가
    MockTransport로 가로챈다). 안 주면 `timeout`으로 하나 만들어 쓰고 닫는다.
    """
    key = api_keys.gemini_key()
    if not key:
        raise GeminiError("Gemini API 키가 없습니다.")
    # 모델명은 api_keys가 허용 목록(헤더)·운영자 값(.env)으로 이미 걸렀다.
    model = api_keys.gemini_model()
    url = f"{settings.gemini_base_url.rstrip('/')}/models/{model}:generateContent"
    headers = {"x-goog-api-key": key, "Content-Type": "application/json"}

    async def _post(c: httpx.AsyncClient, thinking: bool) -> httpx.Response:
        body = build_body(
            parts,
            system=system,
            max_output_tokens=max_output_tokens,
            temperature=temperature,
            thinking=thinking,
        )
        try:
            return await c.post(url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            # 예외 문자열은 URL(키 없음)과 원인만 담는다.
            raise GeminiError(f"Gemini 요청 실패: {type(exc).__name__}") from exc

    async def _run(c: httpx.AsyncClient) -> str:
        resp = await _post(c, thinking=True)
        if resp.status_code == 400:
            # thinkingLevel을 모르는 모델일 수 있다 — 한 번만 기본 수준으로 재시도.
            logger.info("Gemini 400 — thinkingConfig 없이 1회 재시도 (model=%s)", model)
            resp = await _post(c, thinking=False)
        if resp.status_code >= 400:
            raise GeminiError(_error_message(resp), status=resp.status_code)
        try:
            data = resp.json()
        except ValueError as exc:
            raise GeminiError("Gemini 응답을 해석할 수 없습니다.") from exc
        return extract_text(data)

    if client is not None:
        return await _run(client)
    async with httpx.AsyncClient(timeout=timeout) as owned:
        return await _run(owned)
