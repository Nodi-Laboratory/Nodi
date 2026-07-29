"""교과서 figure 캡션 비전 생성(D118) — figure_judge와 동형 구조.

figure_judge가 절대거리 top-K 후보 중 하나를 '선택'(D93/D103)했다면, 이 모듈은
페이지 본문을 컨텍스트로 캡션을 직접 '생성'한다(D118). 잘라낸 figure 이미지
(base64)와 페이지 텍스트·parsed 캡션·alt를 judge_* 비전 엔드포인트(OpenAI 호환)에
보내 검색용 캡션 한두 문장을 받는다.

**figure_judge와 같은 판정 계열을 재사용한다** — 같은 judge_base_url/judge_model/
judge_api_key로 호출하고, `image_data_uri`·`is_configured`는 figure_judge에서
임포트해 그대로 쓴다(복제 금지). 타임아웃(JUDGE_TIMEOUT)·회로차단 임계치
(CIRCUIT_BREAK_THRESHOLD=5)·1회 재시도 규약도 동일하다 — 이유는 figure_judge
독스트링 참조(죽은 엔드포인트에서 connect 대기 누적 방지, thinking off 공백루프
잘림 대비 재시도).

캡션 생성은 판정과 달리 자유 텍스트라 파싱이 단순하다(공백 정규화 + 500자 캡).
파싱 후 빈 캡션은 None과 동일 취급 — 호출부(워커)가 parsed 캡션으로 폴백하거나
캡션 없이 failed 처리한다(D118). 개별 실패는 raise하지 않고 None으로 강등한다.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

import httpx

from ..config import get_settings
# figure_judge와 같은 판정 계열 — 유틸은 임포트해 재사용한다(복제 금지, D118).
from .figure_judge import (
    CIRCUIT_BREAK_THRESHOLD,
    JUDGE_TIMEOUT,
    image_data_uri,
    is_configured,
)

logger = logging.getLogger("nodi.figure_caption")
settings = get_settings()

# 생성 캡션 절단 상한(문자) — 검색용 한두 문장이면 충분하고, 길면 벡터가 희석된다.
CAPTION_LIMIT = 500

# 재노출용(figure_judge에서 온 심볼을 이 모듈 API로도 노출) — lint의 미사용 경고 회피.
__all__ = [
    "CIRCUIT_BREAK_THRESHOLD",
    "JUDGE_TIMEOUT",
    "image_data_uri",
    "is_configured",
    "build_caption_messages",
    "parse_caption",
    "caption_one",
    "caption_all",
]


def build_caption_messages(
    page_text: str, parsed_caption: str, alt: str, image_data_uri: str
) -> list[dict]:
    """D118: 캡션 '생성' — D93/D103의 후보 '선택'을 대체한다. 페이지 본문 용어를
    흡수해 검색력을 높이되, parsed 캡션의 고유명사를 보존하고 지어내기를 금지한다.

    parsed 캡션·alt는 있을 때만 힌트 라벨로 얹는다(없으면 프롬프트 잡음 제거).
    이미지 + 텍스트를 한 user 턴에 담는다(figure_judge.build_judge_messages 동형).
    """
    hints = []
    if parsed_caption:
        hints.append(f"파서가 찾은 원문 캡션: {parsed_caption}")
    if alt:
        hints.append(f"대체 텍스트: {alt}")
    hint_block = ("\n".join(hints) + "\n") if hints else ""
    prompt = (
        "당신은 교과서 편집자다. 위 이미지는 교과서 페이지에서 잘라낸 그림이고,\n"
        "아래는 그 페이지의 본문 텍스트다.\n"
        f"{hint_block}"
        "본문의 용어를 사용해 이 그림을 설명하는 **검색용 캡션을 한국어 1~2문장**으로 써라.\n"
        "원문 캡션이 있으면 그 고유명사(작품명·인물명·소장처)를 그대로 보존하라.\n"
        "그림에 없는 내용을 지어내지 마라. 캡션 문장만 출력하라.\n\n"
        f"페이지 본문:\n{page_text}"
    )
    return [{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": image_data_uri}},
            {"type": "text", "text": prompt},
        ],
    }]


def parse_caption(content: str) -> str:
    """생성 응답 → 정규화된 캡션. 연속 공백(탭 포함) 단일화 + CAPTION_LIMIT 절단.

    탭은 추론형 모델 reasoning 폭주를 유발하고(figure_judge `_clean` 실측), 검색
    임베딩에도 잡음이다. 빈·공백뿐 응답은 '' — caption_all이 None으로 강등한다.
    """
    return " ".join((content or "").split())[:CAPTION_LIMIT]


async def _call_caption(
    client: httpx.AsyncClient,
    page_text: str,
    parsed_caption: str,
    alt: str,
    image_bytes: bytes,
    ext: str,
) -> str:
    payload = {
        "model": settings.judge_model,
        "messages": build_caption_messages(
            page_text, parsed_caption, alt, image_data_uri(image_bytes, ext)
        ),
        # EXAONE 4.5 권장 파라미터(judge와 동일 계열) — thinking off로 빠른 생성.
        "max_tokens": 512,
        "temperature": 1.0,
        "top_p": 0.95,
        "presence_penalty": 1.5,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    resp = await client.post(
        f"{settings.judge_base_url.rstrip('/')}/chat/completions",
        json=payload,
        headers={"Authorization": f"Bearer {settings.judge_api_key}"},
    )
    resp.raise_for_status()
    choice = resp.json()["choices"][0]
    content = choice["message"].get("content")
    if not content:
        raise ValueError(
            f"캡션 응답에 content 없음 (finish_reason={choice.get('finish_reason')!r})"
        )
    return content


async def caption_one(
    client: httpx.AsyncClient,
    page_text: str,
    parsed_caption: str,
    alt: str,
    image_bytes: bytes,
    ext: str,
) -> str:
    """캡션 생성 1회 — 빈 응답(ValueError)이면 1회 재시도 후 raise(judge_one 규약).

    thinking off에서 공백 루프로 응답이 잘리는 사고에 대비해 1회 재시도한다.
    반환은 정규화된 캡션 문자열(빈 캡션 '' 가능 — 호출부 caption_all이 None 강등).
    """
    try:
        content = await _call_caption(client, page_text, parsed_caption, alt, image_bytes, ext)
        return parse_caption(content)
    except ValueError as exc:
        logger.info("캡션 생성 실패 — 재시도: %s", exc)
        content = await _call_caption(client, page_text, parsed_caption, alt, image_bytes, ext)
        return parse_caption(content)


async def caption_all(
    items: list[dict],
    *,
    concurrency: int,
    heartbeat: Callable[[], Awaitable[None]] | None = None,
) -> list[str | None]:
    """figure 레코드 목록에 캡션을 생성 — 반환 순서는 items 순서 그대로.

    items[i] = {"image_bytes", "ext", "page_text", "parsed_caption", "alt"}.
    asyncio.Semaphore(concurrency)로 동시 호출을 제한하고, 각 항목 완료 시
    heartbeat가 있으면 await한다(장기 잡 하트비트 D120 — jobs.updated_at 전진으로
    스테일 재클레임 오탐 방지).

    개별 실패(재시도 포함 최종 예외)·빈 캡션은 raise하지 않고 None을 반환한다 —
    호출부(워커)가 parsed 캡션으로 폴백하거나 캡션 없이 failed 처리한다(D118).
    연속 CIRCUIT_BREAK_THRESHOLD회 실패 시 잔여 항목 생성을 생략하고 전부 None으로
    둔다(회로차단, figure_judge.judge_all 동형) — 스킵된 항목은 heartbeat도
    부르지 않는다.
    """
    results: list[str | None] = [None] * len(items)
    if not items:
        return results

    sem = asyncio.Semaphore(max(1, concurrency))
    # 회로차단 상태 — 세마포어로 직렬화된 임계 구간에서만 갱신되므로 락 불필요.
    state = {"consecutive": 0, "broken": False}

    async def worker(client: httpx.AsyncClient, i: int) -> None:
        r = items[i]
        async with sem:
            if state["broken"]:
                return  # 회로 개방 — 잔여 생성 생략(None 유지, heartbeat도 생략)
            try:
                caption = await caption_one(
                    client,
                    r.get("page_text", ""),
                    r.get("parsed_caption", ""),
                    r.get("alt", ""),
                    r["image_bytes"],
                    r["ext"],
                )
                # 빈 캡션은 None과 동일 취급(호출부 폴백 신호).
                results[i] = caption or None
                state["consecutive"] = 0
            except Exception as exc:  # 재시도 포함 최종 실패 — 강등(raise 금지)
                results[i] = None
                state["consecutive"] += 1
                if (
                    state["consecutive"] >= CIRCUIT_BREAK_THRESHOLD
                    and not state["broken"]
                ):
                    state["broken"] = True
                    logger.warning(
                        "figure 캡션 생성 연속 %d회 실패 — 잔여 생성 생략(회로차단): %s",
                        CIRCUIT_BREAK_THRESHOLD, exc,
                    )
            if heartbeat is not None:
                await heartbeat()

    async with httpx.AsyncClient(timeout=JUDGE_TIMEOUT) as client:
        await asyncio.gather(*(worker(client, i) for i in range(len(items))))
    return results
