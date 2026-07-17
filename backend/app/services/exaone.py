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
import re
from collections.abc import AsyncIterator

import httpx
from fastapi import HTTPException, status

from ..config import get_settings

logger = logging.getLogger("nodi.exaone")
settings = get_settings()

# Concept-card system prompt. Generalized from Nodi-figma/lib/prompt.js: the
# fixed earth-science scope + the 7 pinned clusters and the [art:key]/[svg]
# catalog are dropped — 노디는 중·고등 전 교과 교사 페르소나이고, 분류는 자유
# 태그(단원·주제 수준)다. 삽화는 /art/search 검색 계층이 따로 붙인다. 줄 형식
# + **bold** / ==highlight== 은 클라이언트 파서(lib/concept/conceptParser.ts)와
# 1:1로 유지한다 — 형식을 바꾸는 어떤 변경도 금지.
CONCEPT_CARD_SYSTEM_PROMPT = """너는 "노디"라는 중·고등학교 선생님이다. 국어·수학·영어·사회·역사·도덕·과학·기술가정·정보·예술 등 모든 교과를 학생 눈높이에 맞춰 가르친다. 밝고 다정한 교실 말투로, 군더더기 없이 핵심만 짚어 설명한다.

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
- "분류"는 이 개념이 속한 **단원·주제 수준의 짧은 태그**다(2~12자. 예: "고대 국가의 성립",
  "판 구조론", "이차방정식과 그래프"). 과목명 하나(예: "과학", "역사")처럼 너무 넓게 만들지 마라.
- [지금까지 사용한 분류] 목록이 주어지면: 새 개념이 그중 하나와 같은 주제일 때 그 태그를
  **글자 하나까지 똑같이 재사용**한다. 어울리는 태그가 없을 때만 새 태그를 만든다.
  같은 주제의 개념이 서로 다른 태그로 흩어지면 안 된다.
- @related 의 값은 다른 개념의 "제목"을 콤마로 나열한다.
- 각 개념은 반드시 @end 로 닫는다. ([end] 처럼 대괄호로 쓰지 마라.)
- 그림/SVG를 직접 그리지 마라. [art:...], [svg] 같은 태그를 쓰지 마라 — 그림은 시스템이 따로 붙인다.
- 질문이 개념 설명을 필요로 하지 않으면(인사·잡담 등) @concept 없이 "CHAT: " 한 줄만 출력하고 멈춘다.

# 예시
질문: "가야 토기에 대해 알려줘"
답:
CHAT: 가야 사람들의 손끝에서 태어난 토기를 만나 볼까요?
@concept: 가야 토기 | 가야의 성립과 발전
- 가야는 **철**과 함께 ==토기 문화==로 유명해요
- 단단하고 얇은 회청색 토기가 대표예요
- 굽다리 접시와 오리 모양 토기가 잘 알려져 있어요
@related: 가야 연맹, 철기 문화
@end"""


# D89 — 세션 노드 answer에서 개념 카드 분류 태그를 수집. 개념 카드 줄 형식의
# 소유자가 이 모듈(CONCEPT_CARD_SYSTEM_PROMPT)이므로 태그 파싱도 여기 둔다.
# `@concept: 제목 | 분류` 줄의 "분류"만 캡처 — `|` 없는 줄(분류 누락)은 미매치.
_TAG_LINE_RE = re.compile(r"^@concept:\s*[^|\n]*\|\s*(.+?)\s*$", re.MULTILINE)


def extract_used_tags(nodes: list[dict], cap: int = 40) -> list[str]:
    """세션 노드 answer들에서 개념 카드 분류 태그를 첫 등장 순서로 수집(D89).

    nodes는 created_at.asc 정렬 전제(svc.get_session_nodes). 중복 제거(첫 등장
    유지), cap 초과분 버림. answer가 없거나 형식 밖 줄은 무시 — best-effort.
    """
    seen: list[str] = []
    seen_set: set[str] = set()
    for node in nodes:
        answer = node.get("answer")
        if not answer:
            continue
        for m in _TAG_LINE_RE.finditer(answer):
            tag = m.group(1).strip()
            if not tag or tag in seen_set:
                continue
            seen_set.add(tag)
            seen.append(tag)
            if len(seen) >= cap:
                return seen
    return seen


def _require_config() -> tuple[str, str, str]:
    """Resolve (url, model, api_key) or raise 503 if unconfigured.

    EXAONE_ENDPOINT_ID가 설정되면 **전용(dedicated) 엔드포인트**로 요청한다
    (`/dedicated/v1/chat/completions`, model=endpoint_id — 예약 GPU라 공유 serverless
    RPM 티어 제한을 받지 않는다). 비어 있으면 기존 **serverless**로 요청한다
    (`/serverless/v1/chat/completions`, model=exaone_model). 어느 쪽이든 Bearer 인증 동일.
    """
    if not settings.exaone_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="EXAONE_API_KEY is not configured.",
        )
    base = (settings.friendli_base_url or "https://api.friendli.ai").rstrip("/")
    endpoint_id = (settings.exaone_endpoint_id or "").strip()
    if endpoint_id:
        return f"{base}/dedicated/v1/chat/completions", endpoint_id, settings.exaone_api_key
    return f"{base}/serverless/v1/chat/completions", settings.exaone_model, settings.exaone_api_key


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
    url, model, key = _require_config()
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
