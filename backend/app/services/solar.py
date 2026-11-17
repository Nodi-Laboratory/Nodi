"""채팅 클라이언트 — 개념 카드 스트리밍 생성 (Gemini 우선, Upstage solar 폴백).

모듈 이름이 solar인 것은 역사다(호출부가 많아 안 바꾼다). 2026-11-17 사용자
결정("모두 gemini로")으로 **Gemini 키가 있으면 Gemini**, 없으면 아래 D108의
Upstage 경로 그대로 간다 — `resolve_route` 참조.

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
from . import api_keys, app_settings

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
  (`\\(...\\)`·`\\[...\\]`는 쓰지 마라). 수식 안에 한글을 넣지 마라 — 기호와 수만 담고
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


# ---------------------------------------------------------------------------
# 공급자 선택 (2026-11-17 "모두 gemini로")
#
# ## 우선순위 — 호출마다 정한다
#
#   1. `api_keys.gemini_key()`가 비어 있지 않으면 **Gemini**. 그 키는 .env가
#      먼저고, .env가 비면 요청 헤더(X-Gemini-Key)다 — 비전과 같은 규칙이다.
#   2. 아니면 `api_keys.upstage_key()`(.env 먼저, 없으면 X-Upstage-Key)로
#      **Upstage** — 예전 동작 그대로다.
#   3. 둘 다 없으면 503.
#
# 대회 운영 서버는 Gemini 키가 없다(해외 모델 규정) — 그 서버가 계속 Upstage로
# 도는 것이 이 폴백의 존재 이유다. 그래서 Upstage 갈래는 **바꾸지 않는다**.
# 업로드 워커처럼 요청 헤더가 없는 곳은 .env 키만 보이므로 자연히 .env 기준이다.
# ---------------------------------------------------------------------------

#: Gemini 모델 이름 허용 패턴 — 이름이 JSON 본문에만 들어가지만(URL 경로 아님)
#: 관리자 오버레이·헤더 같은 문자열이 그대로 흘러가지 않도록 여기서 거른다.
_GEMINI_MODEL_RE = re.compile(r"^gemini-[a-z0-9.\-]+$")
_GEMINI_CHAT_FALLBACK = "gemini-3.5-flash"
_GEMINI_LIGHT_FALLBACK = "gemini-3.5-flash-lite"
#: 소형 작업(질문 코치·연결 판정)에 쓰던 Upstage 모델 이름 — Gemini에서는 light로.
_LIGHT_SOLAR = "solar-pro2"
#: compat 층이 받는 reasoning_effort. "none"은 flash-lite가 400으로 거절한다
#: (실측 2026-11-17) — 허용 목록에서 뺀다.
_REASONING_EFFORTS = ("minimal", "low", "medium", "high")


@dataclass(frozen=True)
class Route:
    """이번 호출이 어디로 어떤 모델로 가는가. 키는 repr에서 뺀다(로그·예외 방어)."""

    provider: str  # "gemini" | "upstage"
    url: str
    model: str
    key: str = field(repr=False)

    @property
    def label(self) -> str:
        return "Gemini" if self.provider == "gemini" else "Upstage"


def _safe_gemini_name(name: str | None, fallback: str) -> str:
    n = (name or "").strip()
    return n if _GEMINI_MODEL_RE.match(n) else fallback


def gemini_model_for(requested: str | None, *, base: str | None = None) -> str:
    """호출부가 요청한 모델 이름을 Gemini 모델로 옮긴다 — 매핑은 여기 하나뿐이다.

    - `gemini-…` 이름: 허용 패턴이면 그대로(관리자가 직접 고른 값 존중)
    - `solar-pro2`: 소형 작업용 이름 → light 모델
    - 그 밖(None·`solar-pro3`·`solar-mini` 등): 대화 모델

    허용 패턴 밖의 이름은 조용히 대화 모델로 떨어진다 — 임의 문자열이 업스트림으로
    나가지 않는 것이 목적이다.
    """
    chat = _safe_gemini_name(base or settings.gemini_chat_model, _GEMINI_CHAT_FALLBACK)
    light = _safe_gemini_name(settings.gemini_light_model, _GEMINI_LIGHT_FALLBACK)
    name = (requested or "").strip()
    if name.startswith("gemini"):
        return name if _GEMINI_MODEL_RE.match(name) else chat
    if name == _LIGHT_SOLAR:
        return light
    return chat


def active_provider() -> str | None:
    """지금 요청 문맥에서 쓰일 공급자. 둘 다 없으면 None. (진단·표시용)"""
    if api_keys.gemini_key():
        return "gemini"
    if api_keys.upstage_key():
        return "upstage"
    return None


def active_chat_model(requested: str | None = None) -> str:
    """지금 문맥에서 **실제로 나갈** 모델 이름. 키가 없으면 Upstage 설정값을 보인다."""
    if active_provider() == "gemini":
        return gemini_model_for(requested)
    return _upstage_model_for(requested)


def _upstage_model_for(requested: str | None) -> str:
    n = (requested or "").strip()
    # Gemini 이름이 오버레이에 남아 있어도 Upstage에는 보내지 않는다(400 방지).
    if not n or n.startswith("gemini"):
        return settings.upstage_chat_model
    return n


def resolve_route(model: str | None = None) -> Route:
    """(공급자, URL, 모델, 키) 해석 — 둘 다 미설정이면 503. 우선순위는 위 주석."""
    gkey = api_keys.gemini_key()
    if gkey:
        base = settings.gemini_openai_base_url.rstrip("/")
        return Route("gemini", f"{base}/chat/completions", gemini_model_for(model), gkey)
    key = api_keys.upstage_key()  # .env 우선, 없으면 요청 헤더
    if not key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GEMINI_API_KEY or UPSTAGE_API_KEY is not configured.",
        )
    base = settings.upstage_base_url.rstrip("/")
    return Route("upstage", f"{base}/chat/completions", _upstage_model_for(model), key)


#: Gemini 판단 단계(tools 동반) 출력 상한 — 병렬 도구 3개의 인자가 들어갈 만큼.
_GEMINI_JUDGE_MAX_TOKENS = 192

#: 모델별로 **거절당한** 사고 강도 기록 — 같은 400을 호출마다 겪지 않게 기억한다.
#: 값은 그 모델에 쓸 강도(None이면 필드 자체를 뺀다).
_EFFORT_OVERRIDE: dict[str, str | None] = {}


def _reasoning_effort() -> str:
    eff = (settings.gemini_reasoning_effort or "").strip().lower()
    return eff if eff in _REASONING_EFFORTS else "minimal"


def _apply_effort(payload: dict[str, Any], route: Route) -> None:
    """Gemini 호출의 사고 강도를 payload에 얹는다 (compat 층 `reasoning_effort`).

    사고 모델이라 아무것도 안 주면 기본 강도로 생각하느라 첫 글자까지 수 초가
    늘고, 생각 토큰이 max_tokens를 먹는다(실측 2026-11-17: gemini-3.5-flash 판단
    2차 호출 기본 6.7s → minimal 1.5s). 추론 텍스트는 compat 응답에 실리지 않는다
    (include_thoughts를 안 켠다) — 누출은 호출부가 content만 읽는 것으로 막는다.
    """
    if route.model in _EFFORT_OVERRIDE:
        eff = _EFFORT_OVERRIDE[route.model]
    else:
        eff = _reasoning_effort()
    if eff:
        payload["reasoning_effort"] = eff
    else:
        payload.pop("reasoning_effort", None)


def _downgrade_effort(route: Route, payload: dict[str, Any], status_code: int, body: str) -> bool:
    """사고 강도를 모델이 거절했으면(400 "Thinking level … not supported") 한 단계
    낮춰 다시 보낼 수 있게 payload를 고친다. 고쳤으면 True.

    실측 2026-11-17: `minimal`은 3.5-flash·flash-lite·3.6-flash가 받지만 3.7-flash는
    "Thinking level MINIMAL is not supported"로 400이다(`none`은 flash-lite가 거절).
    모델마다 다르므로 관리자가 모델을 바꿔도 죽지 않게 minimal → low → (필드 생략)
    순으로 물러난다. 이 400은 본문 처리 전에 오므로 재시도해도 이중 과금이 없다.
    """
    cur = payload.get("reasoning_effort")
    if route.provider != "gemini" or status_code != 400 or not cur:
        return False
    if "thinking level" not in body.lower() and "reasoning" not in body.lower():
        return False
    nxt = "low" if cur == "minimal" else None
    _EFFORT_OVERRIDE[route.model] = nxt
    logger.warning("%s가 사고 강도 %s를 거절 — %s로 물러난다", route.model, cur, nxt or "생략")
    _apply_effort(payload, route)
    return True


#: thought_signature 검증을 건너뛰게 하는 공식 더미값(실측 2026-11-17: 둘 다 200).
_DUMMY_SIGNATURE = "skip_thought_signature_validator"


#: 도구 결과를 받은 직후 판단 호출 끝에 붙이는 한 줄 — 위 `_GEMINI_JUDGE_MAX_TOKENS`와
#: 짝이다. 상한은 낭비의 **크기**를 자르고, 이 줄은 낭비를 **없앤다**.
_JUDGE_AFTER_TOOL_HINT = (
    "도구 결과를 받았다. 더 부를 도구가 있으면 부르고, 없으면 '완료' 한 단어만 출력한다. "
    "답을 쓰지 마라 — 이 텍스트는 학생에게 가지 않는다."
)


def _gemini_messages(
    messages: list[dict[str, Any]], *, judging: bool = False
) -> list[dict[str, Any]]:
    """Gemini로 보낼 messages 정리 — tool_calls의 thought_signature 보장.

    ## 왜 필요한가 (실측 2026-11-17, gemini-3.5-flash / flash-lite)

    Gemini 3는 함수 호출을 돌려줄 때 `tool_calls[i].extra_content.google
    .thought_signature`를 싣고, **다음 요청에서 그 assistant 메시지를 되돌릴 때
    같은 값이 없으면 400**이다("Function call is missing a thought_signature").
    오케스트레이터는 모델이 준 tool_calls를 **그대로** 되돌려 보내므로 서명은
    자연히 살아 있다(`extra_content`를 지우는 코드가 없다) — 이 함수는 그 전제가
    깨졌을 때(히스토리를 재구성하며 필드를 잃는 등)를 위한 **안전망**이다.

    서명이 하나도 없는 tool_calls 메시지의 첫 호출에만 더미를 얹는다. 병렬 호출은
    첫 호출에만 서명이 오므로 나머지는 건드리지 않는다. 입력은 바꾸지 않는다.

    `judging`(도구 판단 호출)이고 마지막이 도구 결과면 "답을 쓰지 마라" 한 줄을 끝에
    붙인다(사본에만, user 역할).
    """
    out: list[dict[str, Any]] = []
    for m in messages:
        calls = m.get("tool_calls") if m.get("role") == "assistant" else None
        if not calls or any(
            ((c.get("extra_content") or {}).get("google") or {}).get("thought_signature")
            for c in calls
        ):
            out.append(m)
            continue
        fixed = [dict(c) for c in calls]
        fixed[0]["extra_content"] = {"google": {"thought_signature": _DUMMY_SIGNATURE}}
        out.append({**m, "tool_calls": fixed})
    if judging and out and out[-1].get("role") == "tool":
        # 실측 2026-11-17: 이 줄이 없으면 Gemini는 도구 결과를 받은 판단 호출에서
        # 버려질 답을 188~512토큰 통째로 쓴다(호출당 3~9초). ⚠️ **user 역할이어야
        # 먹는다** — 같은 문장을 system으로 붙였더니 여전히 188토큰을 썼다(compat
        # 층이 system을 앞으로 끌어올리는 듯하다). user로 붙이자 2토큰("완료"), 1.3초.
        out.append({"role": "user", "content": _JUDGE_AFTER_TOOL_HINT})
    return out


def _scrub(text: str, key: str) -> str:
    """에러 본문을 로그에 남기기 전에 키가 섞였으면 지운다(업스트림이 되돌려 줄 수 있다)."""
    return text.replace(key, "***") if key else text


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
    route = resolve_route()
    temperature, max_out = await _gen_params()
    payload: dict[str, Any] = {
        "model": route.model,
        "messages": _build_messages(system_prompt, history, question, tag_hint),
        "stream": True,
        "temperature": temperature,
        "max_tokens": max_out,
    }
    if route.provider == "gemini":
        _apply_effort(payload, route)
    if usage_sink is not None:
        # 실측(2026-07-28): 이 옵션이 **없으면 스트리밍 응답에 usage가 아예
        # 없다**. 있으면 마지막 청크에 실려 온다(400 아님 — 확인함).
        payload["stream_options"] = {"include_usage": True}

    async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT) as client:
        for _attempt in range(3):  # 사고 강도 거절 시 한두 번 물러나며 재시도
            async with client.stream(
                "POST", route.url, headers=_headers(route.key), json=payload
            ) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    if _downgrade_effort(route, payload, resp.status_code, body):
                        continue
                    logger.error(
                        "%s chat %s: %s", route.label, resp.status_code,
                        _scrub(body, route.key)[:500],
                    )
                    raise RuntimeError(f"{route.label} chat {resp.status_code}")
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
                    # ⚠️ **`content`만 읽는다.** 사고 모델은 델타에 `reasoning_content`·
                    # `extra_content`(thought_signature)를 실을 수 있다 — 그걸 답에
                    # 섞으면 추론이 학생 화면과 저장 답(canvas_items.body)에 샌다.
                    delta = (choices[0].get("delta") or {}).get("content")
                    if delta:
                        yield delta
                return


async def complete(
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    max_tokens: int | None = None,
    model: str | None = None,  # D149: 원자화만 solar-pro3로. None=전역 채팅 모델.
    temperature: float | None = None,  # None=admin 오버레이/config 값
    timeout: float | None = None,  # None=기본 60초 읽기 타임아웃
) -> Completion:
    """비스트리밍 1회 호출 — ReAct 루프의 도구 판단 단계용(D109).

    반환은 `Completion(message, usage)`. message는 OpenAI 형식 assistant 메시지
    그대로 `{"role","content","tool_calls"}`이고, 호출부가 tool_calls 유무로
    분기한다. usage는 실측 토큰 사용량이다(D113).

    스트리밍을 쓰지 않는 이유: 이 단계의 텍스트는 사용자에게 보내지 않는다.
    도구를 고르는 판단만 필요하므로 완성된 응답 하나면 충분하다.

    `model`을 주면 그 호출만 해당 모델로 나간다(D149 — 강의 원자 생성이
    solar-pro3를 쓰되 전역 채팅 모델은 건드리지 않기 위함). None이면 전역
    모델을 그대로 써 기존 호출부 동작이 불변이다. Gemini 갈래에서는 이 이름을
    `gemini_model_for`가 Gemini 모델로 옮긴다(호출부는 solar 이름을 그대로 넘겨도 된다).

    ⚠️ message는 **가공 없이 그대로** 돌려준다. Gemini는 `tool_calls[i].extra_content`
    (thought_signature)를 다음 요청에 되돌려 받아야 하고, 호출부가 tool_calls를
    통째로 히스토리에 넣는 것이 그 계약을 지키는 가장 단순한 길이다.
    """
    route = resolve_route(model)
    temp, max_out = await _gen_params(max_tokens)
    payload: dict[str, Any] = {
        "model": route.model,
        "messages": (
            _gemini_messages(messages, judging=bool(tools))
            if route.provider == "gemini"
            else messages
        ),
        "temperature": temperature if temperature is not None else temp,
        "max_tokens": max_out,
    }
    if route.provider == "gemini":
        _apply_effort(payload, route)
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
        if route.provider == "gemini":
            # 판단 단계의 쓸모 있는 출력은 도구 이름+인자뿐이다(수십 토큰). 그런데
            # Gemini는 도구 결과를 받은 2차 판단에서 **버려질 답을 통째로 쓴다**
            # (실측 2026-11-17: flash·3.6-flash가 max_tokens 512를 꽉 채워 호출당
            # 3~9초). 그 텍스트는 학생에게 안 가므로 상한을 낮춰 낭비를 자른다.
            # 잘려도 tool_calls가 비어 있을 뿐이라 "도구 불필요"로 정상 처리된다.
            payload["max_tokens"] = min(payload["max_tokens"], _GEMINI_JUDGE_MAX_TOKENS)

    call_timeout = (
        httpx.Timeout(connect=10.0, read=timeout, write=10.0, pool=10.0)
        if timeout
        else _CALL_TIMEOUT
    )
    async with httpx.AsyncClient(timeout=call_timeout) as client:
        resp = await client.post(route.url, headers=_headers(route.key), json=payload)
        for _attempt in range(2):  # 사고 강도 거절 시 물러나며 재시도(위 _downgrade_effort)
            if resp.status_code == 200 or not _downgrade_effort(
                route, payload, resp.status_code, resp.text
            ):
                break
            resp = await client.post(route.url, headers=_headers(route.key), json=payload)
        if resp.status_code != 200:
            logger.error(
                "%s chat %s: %s", route.label, resp.status_code,
                _scrub(resp.text, route.key)[:500],
            )
            raise RuntimeError(f"{route.label} chat {resp.status_code}")
        body = resp.json()
        choices = body.get("choices") or []
        if not choices:
            raise RuntimeError(f"{route.label} chat: 빈 choices")
        choice = choices[0]
        # D112: max_tokens에 걸려 잘리면 `tool_calls`의 arguments JSON이 중간에서
        # 끊긴다. 호출부는 파싱 실패를 빈 인자로 처리하므로 **조용히 엉뚱한
        # 도구 호출**이 된다(검색어 없는 검색 등). 잘렸다는 사실을 로그로 남겨
        # 원인 추적이 가능하게 한다 — 상한을 올릴지 판단하는 근거가 된다.
        msg_out = choice.get("message") or {}
        # tools를 줬는데 tool_calls 없이 잘렸다면 버려질 텍스트가 잘린 것뿐이다 —
        # 경고할 일이 아니다(위 Gemini 상한).
        benign = bool(tools) and not msg_out.get("tool_calls")
        if choice.get("finish_reason") == "length" and not benign:
            logger.warning(
                "판단 응답이 max_tokens(%s)에서 잘렸다 — 도구 인자가 불완전할 수 있다",
                payload["max_tokens"],
            )
        return Completion(
            message=msg_out,
            usage=usage_of(body.get("usage")),
        )
