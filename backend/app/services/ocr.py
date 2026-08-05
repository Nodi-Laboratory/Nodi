"""손글씨 OCR 클라이언트 — VARCO-VISION-2.0-1.7B-OCR (D176).

프롬프트창의 펜 입력판(`PenPad.tsx`)이 흰 종이에 검은 획으로 그린 PNG를 보내면,
이 모듈이 OCR 서버의 `POST /ocr`로 넘겨 **평문 한 덩어리**를 돌려준다.

## 왜 프론트가 직접 부르지 않나

OCR 서버는 **인증이 없고 CORS가 모두 열려 있다**. 브라우저에서 바로 부르면
주소가 곧 공개 GPU 창구가 된다(학생 브라우저 = 인터넷 아무나). 백엔드를 거치면
로그인 검사가 앞에 서고, 주소도 서버 안에만 남는다.

## 좌표는 버린다

서버는 어절마다 `<char>…</char><bbox>…</bbox>`를 주고 `/ocr`가 그걸 파싱해
`text`·`boxes`로 돌려준다. 우리가 쓰는 것은 `text` 하나다 — 입력판의 결과는
**입력창에 들어갈 질문 한 줄**이고, 박스를 얹을 화면이 없다. 나중에 "쓴 자리에
그대로 글자를 보여 주는" 화면을 만들면 그때 `boxes`를 열면 된다(계약에 이미 있다).

## 줄바꿈이 없는 것은 알고 있다

`text`는 조각을 공백으로 이어 붙인 결과라 여러 줄로 쓴 글씨도 한 줄이 된다.
질문 한 줄이 목적이라 지금은 이게 맞다 — 줄을 살리려면 `boxes`의 y로 갈라야
하고, 그건 화면이 생길 때 할 일이다.
"""
from __future__ import annotations

import logging
from urllib.parse import urlsplit, urlunsplit

import httpx

from ..config import get_settings

logger = logging.getLogger("nodi.ocr")
settings = get_settings()


class OcrUnavailable(RuntimeError):
    """설정이 없거나 꺼져 있다 — 고장이 아니라 **아직/지금은 없음**이다."""


class OcrUpstreamError(RuntimeError):
    """모델 서버가 응답하지 않거나 오류를 냈다."""


def resolve_base_url() -> str:
    """OCR 서버 주소. 빈 문자열이면 설정되지 않은 것이다.

    `OCR_BASE_URL`이 있으면 그대로 쓰고, 없으면 **judge 호스트에서 유도한다**
    (사용자 지시 2026-08-04). judge는 `http://호스트:30119/v1` 꼴이므로 경로와
    포트를 떼고 `ocr_port`를 붙인다 — 두 모델이 같은 기계에 떠 있다는 사실이
    유도의 근거다. 다른 기계로 옮기는 순간 이 가정이 깨지므로 그때는
    `OCR_BASE_URL`을 명시한다.

    judge 주소도 비어 있으면 **추측하지 않는다** — D97이 judge_base_url의
    기본값을 없앤 것과 같은 이유다. 기본값이 엉뚱한 서비스를 가리키면 요청이
    조용히 남의 집으로 간다.
    """
    explicit = settings.ocr_base_url.strip().rstrip("/")
    if explicit:
        return explicit

    judge = settings.judge_base_url.strip()
    if not judge:
        return ""
    parts = urlsplit(judge)
    if not parts.scheme or not parts.hostname:
        return ""
    return urlunsplit((parts.scheme, f"{parts.hostname}:{settings.ocr_port}", "", "", ""))


def missing_config() -> list[str]:
    """호출에 필요한데 비어 있는 것 (없으면 빈 리스트). /health/config가 읽는다."""
    missing: list[str] = []
    if not settings.ocr_enabled:
        missing.append("OCR_ENABLED")
    if not resolve_base_url():
        missing.append("OCR_BASE_URL")  # 또는 유도의 출처인 JUDGE_BASE_URL
    return missing


def is_configured() -> bool:
    """부를 수 있는 상태인가. 도달성(네트워크)까지는 보지 않는다 — judge와 같은 방침."""
    return not missing_config()


def clean_text(raw: str) -> str:
    """모델이 준 평문을 입력창에 넣을 한 줄로.

    조각 사이 공백이 겹치거나 줄바꿈이 섞여 오는 경우가 있어 공백을 하나로
    모은다. **글자는 고치지 않는다** — 맞춤법 교정은 우리 일이 아니고, 학생이
    쓴 것과 다른 글자가 들어가면 그게 더 나쁘다.
    """
    return " ".join((raw or "").split())


async def recognize(
    image: bytes,
    *,
    filename: str = "handwriting.png",
    content_type: str = "image/png",
) -> str:
    """손글씨 PNG → 평문. 실패는 예외로 올린다(빈 문자열로 뭉개지 않는다).

    `upscale_image`는 서버 기본값(true)에 맡긴다 — 입력판은 화면 크기라 긴 변이
    2304px에 한참 못 미치고, 문서가 "업스케일해야 정확도가 크게 오른다"고
    명시한다.
    """
    base = resolve_base_url()
    if not base or not settings.ocr_enabled:
        raise OcrUnavailable("OCR 서버가 설정되지 않았습니다.")

    timeout = httpx.Timeout(float(settings.ocr_timeout_seconds), connect=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(
                f"{base}/ocr",
                files={"file": (filename, image, content_type)},
                data={"max_new_tokens": str(settings.ocr_max_new_tokens)},
            )
    except httpx.HTTPError as exc:  # 연결 실패·타임아웃
        logger.warning("ocr 요청 실패: %s", exc)
        raise OcrUpstreamError(str(exc)) from exc

    if res.status_code >= 400:
        # 모델 서버의 400(이미지 디코딩 실패)까지 502로 뭉개지 않는다 — 무엇이
        # 잘못됐는지는 상태 코드에 이미 들어 있다.
        logger.warning("ocr 응답 %s: %s", res.status_code, res.text[:300])
        raise OcrUpstreamError(f"HTTP {res.status_code}")

    try:
        body = res.json()
    except ValueError as exc:
        raise OcrUpstreamError("응답을 해석할 수 없습니다.") from exc

    text = body.get("text")
    if not isinstance(text, str):
        # 계약이 바뀌었거나 다른 서비스를 가리키고 있다. 조용히 빈 값을 주면
        # 화면에는 "알아보지 못했어요"로만 보여 원인을 못 찾는다.
        raise OcrUpstreamError("응답에 text가 없습니다.")
    return clean_text(text)
