"""EXAONE (Friendli serverless endpoint) streaming chat client.

Replaces Gemini for chat-answer generation. Friendli exposes an OpenAI-compatible
chat completions API; we stream `choices[0].delta.content` tokens over SSE.
Ported from Nodi-figma/lib/kexaone.js. Uses httpx (already a dependency) — no
new package required.

The model is instructed (CONCEPT_CARD_SYSTEM_PROMPT) to emit a line-oriented
concept-card format that the frontend parser turns into cards:

    CHAT: <one-line chat bubble>
    @concept: <title> | <category>
    - <body line>            (**bold**, ==highlight==)
    @related: a, b           (optional)
    @end
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

import httpx
from fastapi import HTTPException, status

from ..config import get_settings

logger = logging.getLogger("nodi.exaone")
settings = get_settings()

# Concept-card system prompt. Generalized from Nodi-figma/lib/prompt.js: the
# earth-science scope, the fixed 6 clusters, and the [art:key]/[svg] catalog are
# dropped — nodi is a general assistant, illustrations are attached separately by
# the /art/search retrieval layer. The line format + **bold** / ==highlight== are
# kept 1:1 with the client parser (lib/concept/conceptParser.ts).
CONCEPT_CARD_SYSTEM_PROMPT = """너는 "노디"라는 학습 도우미다. 사용자의 질문에 개념 카드로 답한다. 밝고 친근하지만 군더더기 없이 핵심만 말한다.

# 응답 원칙 (매우 중요)
- 한 응답에 개념은 1~2개만. 서론·맺음말·반복 금지, 핵심만.
- 본문 길이는 질문의 깊이에 맞춘다: 간단한 질문은 2~3줄로 짧게, "자세히"·"왜"·"어떻게"처럼
  깊은 설명이 필요한 질문은 6~8줄까지 늘려 충실히 답한다(최대 8줄). 한 줄에 문장 하나,
  한 문장은 20자 내외로 짧게. 즉 답의 분량이 질문에 따라 달라져야 한다.
- 어려운 용어는 쉬운 말로 풀어 준다. 이모지·표·코드블록·링크 금지.
- 강조: 핵심 용어는 **굵게**, 가장 중요한 키워드 1~2곳은 ==형광펜==으로 칠한다. 둘을 겹쳐도 된다. 줄 끝 공백 금지.
- 사용자의 언어로 답한다.

# 출력 형식 (반드시 이 형식만, 줄 단위)
- 첫 줄: "CHAT: " 로 시작하는 한 문장(채팅 말풍선용 인사/요약).
- 이후 개념마다 아래 블록을 순서대로 쓴다:
    @concept: 제목 | 분류
    - 본문 문장
    - 본문 문장
    @related: 관련개념, 관련개념   (선택)
    @end
- "분류"는 반드시 다음 7개 중 정확히 하나만 사용한다(문자열을 그대로, 새 분류어 금지):
  해수의 운동과 순환 / 지구의 형성과 역장 / 지구 구성 물질과 자원 / 한반도의 지질 /
  대기의 운동과 순환 / 행성의 운동 / 우리은하와 우주의 구조.
  이 서비스는 고등학교 2학년 지구과학 범위다. 질문이 범위와 조금 달라도 위 7개 중 가장
  가까운 단원으로 분류한다. 표기를 위 목록과 글자 하나까지 똑같이 맞춘다.
- @related 의 값은 다른 개념의 "제목"을 콤마로 나열한다.
- 각 개념은 반드시 @end 로 닫는다. ([end] 처럼 대괄호로 쓰지 마라.)
- 그림/SVG를 직접 그리지 마라. [art:...], [svg] 같은 태그를 쓰지 마라 — 그림은 시스템이 따로 붙인다.
- 질문이 개념 설명을 필요로 하지 않으면(인사·잡담 등) @concept 없이 "CHAT: " 한 줄만 출력하고 멈춘다.

# 예시
질문: "지구 내부 구조 알려줘"
답:
CHAT: 지구 속을 층층이 들여다볼까요?
@concept: 지구 내부 구조 | 지구
- 지구는 양파처럼 겹겹이 — 지각, 맨틀, 외핵, 내핵
- 깊이 갈수록 온도와 압력이 ==쑥쑥== 올라가요
- 외핵만 액체 상태 — 자기장의 비밀!
@related: 지진파, 맨틀 대류
@end"""


def _require_config() -> tuple[str, str, str]:
    """Resolve (base_url, api_key, model) or raise 503 if unconfigured."""
    if not settings.exaone_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="EXAONE_API_KEY is not configured.",
        )
    base = (settings.friendli_base_url or "https://api.friendli.ai").rstrip("/")
    return base, settings.exaone_api_key, settings.exaone_model


def _build_messages(
    system_prompt: str, history: list[tuple[str, str]], question: str
) -> list[dict[str, str]]:
    """OpenAI chat `messages`: system + alternating history + latest question."""
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for q, a in history:
        if q:
            messages.append({"role": "user", "content": q})
        if a:
            messages.append({"role": "assistant", "content": a})
    messages.append({"role": "user", "content": question})
    return messages


async def stream_answer(
    history: list[tuple[str, str]],
    question: str,
    system_prompt: str,
) -> AsyncIterator[str]:
    """Yield answer text deltas for the SSE `token` events.

    `history` = ordered [(question, answer), ...] from root to parent.
    `system_prompt` = the already-composed system prompt (concept-card base +
    any context blocks) built by gemini.compose_system_structured in the router.
    """
    base, key, model = _require_config()
    payload = {
        "model": model,
        "messages": _build_messages(system_prompt, history, question),
        "stream": True,
        "stream_options": {"include_usage": True},
        # Speed first: EXAONE reasoning off (matches the figma prototype).
        "chat_template_kwargs": {"enable_thinking": False},
        "temperature": settings.exaone_temperature,
        "max_tokens": settings.exaone_max_tokens,
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    # Generous read timeout for long streamed answers; short connect/pool.
    timeout = httpx.Timeout(connect=10.0, read=180.0, write=10.0, pool=10.0)
    url = f"{base}/serverless/v1/chat/completions"

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")
                logger.error("EXAONE %s: %s", resp.status_code, body[:500])
                raise RuntimeError(f"EXAONE {resp.status_code}")
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line.startswith("data:"):  # SSE comments / blank lines
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue  # ignore partial/non-JSON keep-alive chunks
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = (choices[0].get("delta") or {}).get("content")
                if delta:
                    yield delta
