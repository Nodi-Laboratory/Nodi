"""Upstage solar 채팅 클라이언트 — 개념 카드 스트리밍 생성.

D108: 대화 생성이 EXAONE(Friendli)에서 Upstage solar로 옮겨졌다. 임베딩·문서
파싱이 이미 Upstage라 벤더가 하나로 줄고, 실측에서 왕복 지연이 2.73s → 0.78s로
줄었다(2026-07-28, 각 3회 중앙값). 응답 위생도 나았다 — EXAONE은 추론 과정을
content에 흘렸는데(포르투갈어 조각 포함) solar는 깨끗한 한국어만 냈다.

교과서 도판 비전 판정은 이 모듈이 아니라 별도 계열(judge_* 노브)이며 아직
구현하지 않았다.

모델은 OpenAI 호환 chat completions를 쓴다 — 스트리밍과 tool calling 모두
지원한다(실측). 개념 카드 줄 형식의 소유자는 이 모듈이다:

    CHAT: <한 줄 채팅 말풍선>
    @concept: <제목> | <분류>
    - <본문 줄>            (**굵게**, ==형광펜==)
    @related: a, b         (선택)
    @end

이 형식은 프론트 파서(lib/concept/conceptParser.ts)와 1:1이다 — 바꾸면 양쪽을
같이 바꿔야 한다.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import HTTPException, status

from ..config import get_settings

logger = logging.getLogger("nodi.solar")
settings = get_settings()

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
def extract_used_tags(nodes: list[dict], cap: int = 40) -> list[str]:
    """세션 노드 answer들에서 개념 카드 분류 태그를 첫 등장 순서로 수집(D89).

    nodes는 created_at.asc 정렬 전제(svc.get_session_nodes). 중복 제거(첫 등장
    유지), cap 초과분 버림. answer가 없거나 형식 밖 줄은 무시 — best-effort.

    추출 규약은 프론트 파서(conceptParser.ts)와 동일하게 "|" split의 두 번째
    조각(parts[1])이다 — 정규식(\\s*)이 개행을 넘어 다음 줄을 태그로 오캡처하던
    문제를 줄 단위 처리로 원천 차단하고, 제목에 "|"가 섞여도 캔버스가 실제로
    그룹핑하는 값과 항상 일치한다(task5-1 최종 리뷰 Minor 하드닝).
    """
    seen: list[str] = []
    seen_set: set[str] = set()
    for node in nodes:
        answer = node.get("answer")
        if not answer:
            continue
        for line in answer.splitlines():
            line = line.strip()
            if not line.startswith("@concept:"):
                continue
            parts = line[len("@concept:") :].split("|")
            if len(parts) < 2:
                continue
            tag = parts[1].strip()
            if not tag or tag in seen_set:
                continue
            seen_set.add(tag)
            seen.append(tag)
            if len(seen) >= cap:
                return seen
    return seen


def _require_config() -> tuple[str, str, str]:
    """(url, model, api_key) 해석 — 미설정이면 503.

    Upstage는 단일 베이스 URL에 OpenAI 호환 `/chat/completions`를 제공한다.
    EXAONE 시절의 serverless/dedicated 분기는 사라졌다(D108).
    """
    if not settings.upstage_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="UPSTAGE_API_KEY is not configured.",
        )
    base = settings.upstage_base_url.rstrip("/")
    return f"{base}/chat/completions", settings.upstage_chat_model, settings.upstage_api_key


def _build_messages(
    system_prompt: str, history: list[tuple[str, str]], question: str
) -> list[dict[str, str]]:
    """OpenAI chat `messages`: system + 히스토리 교대 + 마지막 질문."""
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for q, a in history:
        if q:
            messages.append({"role": "user", "content": q})
        if a:
            messages.append({"role": "assistant", "content": a})
    messages.append({"role": "user", "content": question})
    return messages


def _headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


# 긴 스트리밍 답변을 위해 read는 넉넉히, connect/write는 짧게.
_STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=180.0, write=10.0, pool=10.0)
# 도구 판단처럼 스트리밍이 아닌 호출은 더 짧아도 된다.
_CALL_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)


async def stream_answer(
    history: list[tuple[str, str]],
    question: str,
    system_prompt: str,
) -> AsyncIterator[str]:
    """SSE `token` 이벤트용 답변 텍스트 델타를 yield.

    `history` = root→parent 순서의 [(질문, 답변), ...].
    `system_prompt` = 이미 조립된 시스템 프롬프트(개념 카드 베이스 + 컨텍스트 블록).
    """
    url, model, key = _require_config()
    payload = {
        "model": model,
        "messages": _build_messages(system_prompt, history, question),
        "stream": True,
        "temperature": settings.chat_temperature,
        "max_tokens": settings.chat_max_tokens,
    }

    async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT) as client:
        async with client.stream("POST", url, headers=_headers(key), json=payload) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")
                logger.error("Upstage chat %s: %s", resp.status_code, body[:500])
                raise RuntimeError(f"Upstage chat {resp.status_code}")
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line.startswith("data:"):  # SSE 주석·빈 줄
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue  # 부분/비JSON keep-alive 청크 무시
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = (choices[0].get("delta") or {}).get("content")
                if delta:
                    yield delta


async def complete(
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    """비스트리밍 1회 호출 — ReAct 루프의 도구 판단 단계용(D109).

    반환은 OpenAI 형식 assistant 메시지 그대로:
    `{"role": "assistant", "content": str|None, "tool_calls": [...]|None}`.
    호출부가 tool_calls 유무로 분기한다.

    스트리밍을 쓰지 않는 이유: 이 단계의 텍스트는 사용자에게 보내지 않는다.
    도구를 고르는 판단만 필요하므로 완성된 응답 하나면 충분하다.
    """
    url, model, key = _require_config()
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": settings.chat_temperature,
        "max_tokens": max_tokens or settings.chat_max_tokens,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    async with httpx.AsyncClient(timeout=_CALL_TIMEOUT) as client:
        resp = await client.post(url, headers=_headers(key), json=payload)
        if resp.status_code != 200:
            logger.error("Upstage chat %s: %s", resp.status_code, resp.text[:500])
            raise RuntimeError(f"Upstage chat {resp.status_code}")
        choices = resp.json().get("choices") or []
        if not choices:
            raise RuntimeError("Upstage chat: 빈 choices")
        return choices[0].get("message") or {}
