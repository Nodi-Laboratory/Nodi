"""손글씨를 **비전 모델로** 읽는 예비 경로 (D181).

## 왜 필요한가

질문 펜(D176)은 전용 OCR GPU(VARCO) 하나에 매여 있다. 그 GPU가 내려가면
학생이 쓴 글씨가 **통째로 막힌다** — "준비하고 있어요"만 뜨고, 방금 손으로 쓴
질문을 자판으로 다시 쳐야 한다. 실측 2026-08-06: 로컬에서 터널이 끊긴 채였고
질문 펜이 아무것도 못 읽었다.

그런데 같은 화면의 **표시 해석은 멀쩡히 돌았다.** 비전 모델(judge_* 계열)은
다른 GPU에 떠 있고, 그것도 글자를 읽을 수 있다. 하나가 죽었다고 기능 전체가
멈출 이유가 없다.

## 예비이지 대체가 아니다

VARCO는 **OCR 전용**이라 손글씨를 더 정확히 읽는다. 비전 모델은 범용이라
글자를 "이해해서" 다시 쓰는 쪽에 가깝다 — 학생이 안 쓴 글자를 지어낼 여지가
그만큼 크다. 그래서 순서를 바꾸지 않는다: **언제나 VARCO를 먼저** 부르고,
그쪽이 못 받을 때만 여기로 온다.

## 지어내지 않게 하는 장치

프롬프트가 하는 일은 하나다 — **옮겨 적기**. 고쳐 쓰기·풀이·번역을 금지하고,
못 읽으면 빈 문자열을 내게 한다. "읽을 수 없다"가 "그럴싸한 오답"보다 낫다
(D178에서 배운 것과 같다: 틀린 답은 그럴싸해서 아무도 못 잡는다).
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..config import get_settings
from . import ink_marks
from .figure_judge import image_data_uri

logger = logging.getLogger("nodi.handwriting_vision")
settings = get_settings()

#: 손글씨 한 판이 이보다 길 일은 없다. 폭주만 막는다.
MAX_CHARS = 400

SYSTEM = """너는 학생이 손으로 쓴 글씨를 **그대로 옮겨 적는** 도우미다.

그림에는 흰 종이에 검은 펜으로 쓴 한국어 문장이 있다.

지켜야 할 것:
- **옮겨 적기만 한다.** 고쳐 쓰지 말고, 풀지 말고, 번역하지 말고, 답하지 마라.
- 맞춤법이 틀렸어도 **쓰인 대로** 적는다. 고치면 학생이 쓰지 않은 질문이 된다.
- 글씨가 아닌 것(그림·도형·얼룩)은 적지 마라.
- **못 읽겠으면 아무것도 쓰지 마라.** 빈 줄을 내는 것이 지어내는 것보다 낫다."""

FORMAT = """지금부터 **옮겨 적은 글자만** 한 줄로 출력한다. 머리말·따옴표·설명·
이모지를 쓰지 마라. 못 읽었으면 빈 줄을 내라."""


def build_messages(png: bytes) -> list[dict[str, Any]]:
    """전사 요청 메시지.

    **user 메시지 하나**에 그림 먼저, 지시 나중이다 — `ink_marks`가 실측으로
    찾은 그 순서다(2026-08-05: 지시를 system에 두면 묻혔다). 그림을 본 직후의
    마지막 지시가 이긴다.
    """
    return [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": image_data_uri(png, "png")}},
                {"type": "text", "text": f"{SYSTEM}\n\n{FORMAT}"},
            ],
        }
    ]


def parse(content: str) -> str:
    """모델 출력 → 글자.

    모델이 형식을 어기고 머리말을 붙이는 경우를 한 겹 걷어낸다. 못 읽었다는
    말을 글자로 오해하지 않는 것이 요점이다 — 그대로 두면 학생의 질문이
    "글씨를 읽을 수 없습니다"가 된다.
    """
    text = " ".join((content or "").split())
    if not text:
        return ""
    for lead in ("옮겨 적은 글자:", "글자:", "전사:", "답:"):
        if text.startswith(lead):
            text = text[len(lead) :].strip()
    low = text.lower()
    # 모델이 "못 읽겠다"를 문장으로 답한 경우 — 그것은 글자가 아니다.
    for no in ("읽을 수 없", "알아볼 수 없", "판독", "unreadable", "cannot read"):
        if no in low:
            return ""
    return text.strip("\"'` ")[:MAX_CHARS]


def is_configured() -> bool:
    """비전 창구가 설정돼 있나. 안 돼 있으면 예비 경로 자체가 없다."""
    return bool(
        settings.ocr_vision_fallback_enabled
        and settings.judge_base_url.strip()
        and settings.judge_api_key.strip()
    )


async def recognize(
    png: bytes, *, client: httpx.AsyncClient | None = None
) -> str:
    """손글씨를 비전 모델로 읽는다. **어떤 실패든 빈 문자열**이다.

    호출부는 이미 한 번 실패한 뒤에 온다 — 여기서 또 예외를 올리면 그 갈래를
    한 번 더 처리해야 한다. 빈 문자열은 "못 읽었다"이고, 그 뜻은 VARCO가 빈
    결과를 줬을 때와 같다(D176: 못 읽은 것은 학생 잘못이 아니다).
    """
    if not is_configured() or not png:
        return ""

    payload = {
        "model": settings.judge_model,
        "messages": build_messages(png),
        "max_tokens": 300,
        # figure_caption·ink_marks와 같은 EXAONE 4.5 권장값.
        "temperature": 1.0,
        "top_p": 0.95,
        "presence_penalty": 1.5,
        "chat_template_kwargs": {"enable_thinking": False},
    }

    async def _call(c: httpx.AsyncClient) -> str:
        resp = await c.post(
            f"{settings.judge_base_url.rstrip('/')}/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {settings.judge_api_key}"},
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"].get("content") or ""

    try:
        if client is not None:
            content = await _call(client)
        else:
            # 상한도 admin 노브다 — config에서 직접 읽으면 콘솔에서 바꿔도
            # 예비 경로만 옛 값으로 돈다(D62 점검 2026-08-06).
            async with httpx.AsyncClient(
                timeout=(await ink_marks.read_knobs())["timeout"]
            ) as owned:
                content = await _call(owned)
    except Exception:  # noqa: BLE001 - 예비 경로의 실패는 그냥 못 읽은 것이다
        logger.warning("비전 손글씨 읽기 실패 — 글자 없이 진행", exc_info=True)
        return ""

    text = parse(content)
    if text:
        logger.info("손글씨를 비전 모델로 읽었다(예비 경로) — %d자", len(text))
    return text
