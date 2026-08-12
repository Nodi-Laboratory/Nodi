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
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx
from fastapi import HTTPException, status

from ..config import get_settings
from . import app_settings

logger = logging.getLogger("nodi.solar")
settings = get_settings()

CONCEPT_CARD_SYSTEM_PROMPT = """너는 "노디"라는 중·고등학교 선생님이다. 국어·수학·영어·사회·역사·도덕·과학·기술가정·정보·예술 등 모든 교과를 학생 눈높이에 맞춰 가르친다. 밝고 다정한 교실 말투로, 군더더기 없이 핵심만 짚어 설명한다.

# 응답 원칙 (매우 중요)
- 한 응답에 개념은 1~4개. 서론·맺음말·반복 금지, 핵심만.
- **분량을 억지로 줄이지 마라.** 개념 하나는 보통 2~6문단이고, 필요하면 더 길어도 된다.
  짧게 끊어 쓰느라 설명이 빈약해지는 것이 가장 나쁘다. 다만 같은 말을 반복하지는 마라.
- 한 문단은 2~5문장으로 이어 쓴다. 문장을 한 줄씩 끊지 마라 — 캔버스가 문단 단위로 배치한다.
- 설명의 순서를 지킨다: 무엇인지 → 왜 그런지 → 어떻게 확인하는지 / 예시.
- 어려운 용어는 쉬운 말로 풀어 준다. 이모지·표·코드블록·링크 금지.
- 수식은 LaTeX로 쓴다. **문장 안에서는 `$...$`, 따로 세울 때는 `$$...$$`** 한 가지만 쓴다
  (`\(...\)`·`\[...\]`는 쓰지 마라). 수식 안에 한글을 넣지 마라 — 기호와 수만 담고
  설명은 수식 밖 문장으로 한다. 수식이 필요 없는 설명에 억지로 넣지 마라.
- 강조: 핵심 용어는 **굵게**, 가장 중요한 키워드 1~2곳은 ==형광펜==으로 칠한다. 둘을 겹쳐도 된다. 줄 끝 공백 금지.
- 사용자의 언어로 답한다.

# 출력 형식 (반드시 이 형식만, 줄 단위)
- 첫 줄: "CHAT: " 로 시작하는 한 문장(채팅 말풍선용 인사/요약).
- 이후 개념마다 아래 블록을 순서대로 쓴다:
    @concept: 제목 | 분류
    첫 문단. 여러 문장을 이어 쓴다.

    빈 줄로 문단을 나눈다. 두 번째 문단.
    @related: 관련개념, 관련개념   (선택)
    @end
- **문단은 빈 줄로 나눈다.** 목록이 정말 필요할 때만 `- `로 시작하는 줄을 쓴다
  (나열이 본질인 내용에서만. 설명을 목록으로 쪼개지 마라).
- "분류"는 이 개념이 속한 **교과서 대단원** 이름이다(2~14자). 고르는 법은 아래 [분류 고르기]에 있다.
- @related 의 값은 다른 개념의 "제목"을 콤마로 나열한다.
- 각 개념은 반드시 @end 로 닫는다. ([end] 처럼 대괄호로 쓰지 마라.)
- 그림/SVG를 직접 그리지 마라. [art:...], [svg] 같은 태그를 쓰지 마라 — 그림은 시스템이 따로 붙인다.
- 질문이 개념 설명을 필요로 하지 않으면(인사·잡담 등) @concept 없이 "CHAT: " 한 줄만 출력하고 멈춘다.

# 분류 고르기
- 알맞다: "판 구조론" · "고대 국가의 성립" · "이차방정식과 그래프" · "물질의 상태 변화"
- 넓다(쓰지 마라): "과학" · "역사" · "지구과학", 그리고 과목을 이어 붙인 "지구과학과 지질학" ·
  "생물과 환경". **학문 분야의 이름이 아니라 교과서 목차의 한 줄**이어야 한다.
- 좁다(쓰지 마라): "가야 토기" · "근의 공식" — 카드 제목을 그대로 옮긴 것이다.
- [지금까지 사용한 분류]에 이 개념이 **정말로 속하는** 대단원이 있으면 그 태그를
  글자 하나까지 그대로 재사용한다. 하나도 안 맞으면 새로 만든다.
  ⚠ 주제가 다른데 목록에 있다는 이유로 갖다 붙이지 마라 — 광합성을 "판 구조론"에
  넣으면 지도가 통째로 틀린다. 재사용은 **같은 대단원일 때만**이다.
- 잘게 나누라는 말은 새 태그를 자주 만들라는 말이 아니다. 순서는 (1) 맞는 것 재사용
  (2) 없으면 대단원 수준으로 새로 만들기다.

# 예시
질문: "가야 토기에 대해 알려줘"
답:
CHAT: 가야 사람들의 손끝에서 태어난 토기를 만나 볼까요?
@concept: 가야 토기 | 가야의 성립과 발전
가야는 **철**을 다루는 기술로 널리 알려졌지만, 그 못지않게 뛰어난 것이 ==토기 문화==예요. 낙동강 하류의 여러 나라가 서로 다른 모양의 그릇을 만들면서도 굽는 방식만은 함께 발전시켰거든요.

가야 토기의 가장 큰 특징은 단단하고 얇다는 점이에요. 1,000도가 넘는 높은 온도에서 구웠기 때문인데, 이렇게 구우면 흙 속의 성분이 녹아 붙으면서 회청색을 띠게 돼요. 두드리면 쇳소리에 가까운 맑은 소리가 납니다.

대표적인 그릇으로는 굽다리 접시와 오리 모양 토기가 있어요. 굽다리 접시는 다리에 뚫린 구멍의 모양으로 어느 지역 것인지 구별할 수 있고, 오리 모양 토기는 죽은 사람의 영혼을 옮겨 준다고 믿어 무덤에 함께 묻었습니다.
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


# ---------------------------------------------------------------------------
# 히스토리 위생 (2026-08-07 실측)
#
# ## 형식이 깨진 답은 **나쁜 few-shot 예시**가 된다
#
# 모델이 `@concept:` 봉투를 빠뜨린 답을 한 번 내면, 그 답이 다음 턴의
# assistant 메시지로 들어가 **모델이 자기를 따라 한다.** 한 번 깨지면 그
# 세션은 계속 깨진 채로 간다. 실측(질문 하나를 6회씩, solar-pro3):
#
#     히스토리 없음           @concept 있음  5/6
#     형식 지킨 답 1개                       3/6
#     형식 깨진 답 1개                       0/6   ← 되돌아오지 않는다
#     형식 깨진 답 2개                       0/6
#
# 그 결과가 학생에게 어떻게 보이는지가 문제의 핵심이다: 답은 멀쩡히 생성되고
# 토큰도 다 오는데 **캔버스에는 아무것도 안 뜬다**(파서가 카드를 못 만든다).
# 오류도 로그도 없다. 프론트에도 되살리기 그물을 뒀지만(streamParser),
# 그건 이미 깨진 답을 살리는 것이고 여기서는 **깨지지 않게** 한다.
# ---------------------------------------------------------------------------

#: 첫 **굵은** 낱말 — 봉투를 씌울 때 제목으로 빌린다.
_FIRST_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")

#: 마지막에 한 번 더 못 박는 형식 지시. 히스토리가 길어질수록 시스템 프롬프트가
#: 멀어지므로, 질문 **직전**에 짧게 되풀이한다.
FORMAT_REMINDER = (
    "형식을 지켜라: 첫 줄 `CHAT: 한 문장`, 이어서 개념마다 "
    "`@concept: 제목 | 분류` → 본문 → `@end`. 개념 카드 없이 본문만 쓰지 마라. "
    # 사용자 보고 2026-08-12: 설명을 통째로 `CHAT:` 줄에 담아 보낸 턴이 있었다.
    # 그러면 캔버스에 카드가 하나도 안 생긴다 — 학생 눈에는 "응답이 안 생긴다"다.
    # 앞 문장("본문만 쓰지 마라")은 머리표 없는 **본문**을 막을 뿐, 말풍선으로
    # 도망가는 길은 안 막았다. 두 길을 다 막아야 한 길이 막힌다.
    "`CHAT:` 줄에 설명을 담지 마라 — 그 줄은 한 문장 인사·요약이고, "
    "설명은 반드시 `@concept:` 안에 쓴다."
)


def canonical_answer(answer: str, tag: str | None = None) -> str:
    """저장된 답을 **카드 형식으로 되돌려** 히스토리에 넣는다.

    이미 봉투가 있으면 그대로 둔다. 없으면 제목을 첫 굵은 낱말에서 빌려 씌운다
    (프론트 되살리기와 같은 규칙 — 두 곳이 같은 답을 같은 제목으로 부른다).

    ⚠️ **저장된 원문은 안 건드린다.** 이건 모델에게 보여 줄 사본이다 —
    `canvas_items.body`는 원문 그대로여야 한다(불변식: 파싱은 프론트가 소유).
    """
    text = (answer or "").strip()
    if not text or "@concept:" in text:
        return answer
    m = _FIRST_BOLD_RE.search(text)
    title = (m.group(1) if m else "").strip()[:40]
    # **분류까지 채운 예시가 낫다** — 실측(각 8회): 제목만 4/8 · 제목+분류 6/8 ·
    # 봉투 없음 3/8. 반쪽짜리 예시는 오히려 모델을 헷갈리게 한다.
    parts = [p for p in (title, (tag or "").strip()) if p]
    head = "@concept: " + " | ".join(parts) if parts else "@concept:"
    return f"{head}\n{text}\n@end"


def _build_messages(
    system_prompt: str,
    history: list[tuple[str, str]],
    question: str,
    tag_hint: str | None = None,
) -> list[dict[str, str]]:
    """OpenAI chat `messages`: system + 히스토리 교대 + 형식 되새김 + 질문."""
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for q, a in history:
        if q:
            messages.append({"role": "user", "content": q})
        if a:
            messages.append(
                {"role": "assistant", "content": canonical_answer(a, tag_hint)}
            )
    # 히스토리가 있을 때만 되새긴다 — 첫 턴은 시스템 프롬프트가 바로 위에 있다.
    if history:
        messages.append({"role": "system", "content": FORMAT_REMINDER})
    messages.append({"role": "user", "content": question})
    return messages


def _headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


# 긴 스트리밍 답변을 위해 read는 넉넉히, connect/write는 짧게.
_STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=180.0, write=10.0, pool=10.0)
# 도구 판단처럼 스트리밍이 아닌 호출은 더 짧아도 된다.
_CALL_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)


# ── 토큰 사용량 (D113) ────────────────────────────────────────────────
# 예전에는 `token_estimate = 글자수/4` 어림뿐이라 과금·한도 판단에 쓸 수
# 없었다. 공급자가 주는 실측 usage를 그대로 싣는다.
def usage_of(raw: dict[str, Any] | None) -> dict[str, int]:
    """OpenAI 형식 usage → 저장·합산용 평평한 dict.

    `cached`(prompt_tokens_details.cached_tokens)까지 담는다 — 프리픽스 캐시가
    실제로 먹고 있는지는 이 값 말고는 볼 방법이 없다(실측 2026-07-28: 같은
    프롬프트 2회차에 22 중 16 히트).
    """
    raw = raw or {}
    details = raw.get("prompt_tokens_details") or {}
    return {
        "prompt": int(raw.get("prompt_tokens") or 0),
        "completion": int(raw.get("completion_tokens") or 0),
        "total": int(raw.get("total_tokens") or 0),
        "cached": int(details.get("cached_tokens") or 0),
    }


@dataclass
class Completion:
    """비스트리밍 호출 1회의 결과 — 메시지와 **실측** 토큰 사용량.

    dict 하나로 합치지 않은 이유: 호출부가 `msg.get("tool_calls")`를 보는데
    거기에 usage 키를 섞으면 모델 응답과 계측값의 경계가 흐려진다.
    """

    message: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, int] = field(default_factory=dict)


async def _gen_params(max_tokens: int | None = None) -> tuple[float, int]:
    """생성 파라미터를 **admin 오버레이 우선**으로 읽는다 (D174).

    예전에는 config 값을 그대로 썼다 — 관리자 콘솔에 노브가 있어도 실제
    호출은 그 값을 안 봤다는 뜻이다("화면에만 있는 설정"). 튜너블 규약(D62)은
    오버레이 > config다.

    호출부가 넘긴 `max_tokens`는 그대로 존중한다 — 판단 단계처럼 짧게 끊어야
    하는 호출이 있고, 그건 전역 분량과 다른 이야기다.
    """
    overlay = await app_settings.get_overlay()
    temp = app_settings.as_float(
        overlay, "chat_temperature", settings.chat_temperature, 0.0, 1.5
    )
    limit = max_tokens or app_settings.as_int(
        overlay, "chat_max_tokens", settings.chat_max_tokens, 256, 8192
    )
    return temp, limit


async def stream_answer(
    history: list[tuple[str, str]],
    question: str,
    system_prompt: str,
    *,
    usage_sink: dict[str, int] | None = None,
    tag_hint: str | None = None,
) -> AsyncIterator[str]:
    """SSE `token` 이벤트용 답변 텍스트 델타를 yield.

    `history` = root→parent 순서의 [(질문, 답변), ...].
    `system_prompt` = 이미 조립된 시스템 프롬프트(개념 카드 베이스 + 컨텍스트 블록).

    `usage_sink`를 주면 실측 토큰 사용량을 **거기에 채워 넣는다**(D113).
    yield 타입을 튜플로 바꾸지 않은 이유: 이 제너레이터의 소비자는 전부
    "델타 문자열"을 기대하고, 형을 바꾸면 라우터·테스트가 다 흔들린다.
    usage는 마지막 청크로 한 번 오는 곁다리 정보라 싱크가 더 맞는다.
    """
    url, model, key = _require_config()
    temperature, max_out = await _gen_params()
    payload = {
        "model": model,
        "messages": _build_messages(system_prompt, history, question, tag_hint),
        "stream": True,
        "temperature": temperature,
        "max_tokens": max_out,
    }
    if usage_sink is not None:
        # 실측(2026-07-28): 이 옵션이 **없으면 스트리밍 응답에 usage가 아예
        # 없다**. 있으면 마지막 청크에 실려 온다(400 아님 — 확인함).
        payload["stream_options"] = {"include_usage": True}

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
                # usage 청크는 choices가 비어 있다 — choices 검사보다 먼저 본다.
                if usage_sink is not None and obj.get("usage"):
                    usage_sink.update(usage_of(obj["usage"]))
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
    model: str | None = None,  # D149: 원자화만 solar-pro3로. None=전역 채팅 모델.
) -> Completion:
    """비스트리밍 1회 호출 — ReAct 루프의 도구 판단 단계용(D109).

    반환은 `Completion(message, usage)`. message는 OpenAI 형식 assistant 메시지
    그대로 `{"role","content","tool_calls"}`이고, 호출부가 tool_calls 유무로
    분기한다. usage는 실측 토큰 사용량이다(D113).

    스트리밍을 쓰지 않는 이유: 이 단계의 텍스트는 사용자에게 보내지 않는다.
    도구를 고르는 판단만 필요하므로 완성된 응답 하나면 충분하다.

    `model`을 주면 그 호출만 해당 모델로 나간다(D149 — 강의 원자 생성이
    solar-pro3를 쓰되 전역 채팅 모델은 건드리지 않기 위함). None이면 전역
    모델을 그대로 써 기존 호출부 동작이 불변이다.
    """
    url, default_model, key = _require_config()
    temperature, max_out = await _gen_params(max_tokens)
    payload: dict[str, Any] = {
        "model": model or default_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_out,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    async with httpx.AsyncClient(timeout=_CALL_TIMEOUT) as client:
        resp = await client.post(url, headers=_headers(key), json=payload)
        if resp.status_code != 200:
            logger.error("Upstage chat %s: %s", resp.status_code, resp.text[:500])
            raise RuntimeError(f"Upstage chat {resp.status_code}")
        body = resp.json()
        choices = body.get("choices") or []
        if not choices:
            raise RuntimeError("Upstage chat: 빈 choices")
        choice = choices[0]
        # D112: max_tokens에 걸려 잘리면 `tool_calls`의 arguments JSON이 중간에서
        # 끊긴다. 호출부는 파싱 실패를 빈 인자로 처리하므로 **조용히 엉뚱한
        # 도구 호출**이 된다(검색어 없는 검색 등). 잘렸다는 사실을 로그로 남겨
        # 원인 추적이 가능하게 한다 — 상한을 올릴지 판단하는 근거가 된다.
        if choice.get("finish_reason") == "length":
            logger.warning(
                "판단 응답이 max_tokens(%s)에서 잘렸다 — 도구 인자가 불완전할 수 있다",
                payload["max_tokens"],
            )
        return Completion(
            message=choice.get("message") or {},
            usage=usage_of(body.get("usage")),
        )
