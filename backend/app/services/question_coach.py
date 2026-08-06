"""질문 방향성 코치 (D194) — 무슨 방향이 비었는지 읽어 준다.

## 왜 예시 질문을 주지 않나

사용자 인터뷰의 공통 문제가 **"스스로 질문하기"가 안 된다**는 것이다. 그런데
예상 질문을 보여 주면 학생은 그걸 베낀다 — 베낀 질문은 자기 질문이 아니라서
이 문제를 하나도 안 푼다(사용자 지시 2026-08-06).

그래서 **방향만** 말한다. "비교하는 질문을 해 보라"까지가 우리 몫이고, 무엇을
어떻게 비교할지는 학생이 정한다. 프롬프트가 질문 문장을 못 쓰게 막는 것이
이 서비스에서 제일 중요한 제약이다.

D138이 조사해 둔 자리와 같다: 학습 이득은 캔버스가 아니라 **인출·구성 행위**에서
온다(Chi & Wylie의 Constructive). 답을 그냥 주는 AI로 공부한 학생이 더 못했다는
Bastani 2025의 결과도 같은 방향을 가리킨다 — 우리가 질문까지 대신 써 주면
그 실험을 우리가 재현하는 셈이다.

## 중단이 정상 동작이다

말할 것이 없으면 **말하지 않는다.** 억지로 채우면 "정의를 물어보세요"가 이미
정의를 물은 브랜치에 뜬다 — 그 순간 이 기능은 학생에게 소음이 된다.

  · 방향이 전부 채워졌다  → 중단
  · 이 주제가 이 방향들에 안 맞는다 → 중단 (예: 감상·창작 이야기)
  · 모델이 형식을 어겼다  → 중단

중단도 "이 브랜치는 봤다"로 친다(프론트가 그 카드를 `spokenAt`에 넣는다) —
안 그러면 다음 카드마다 다시 물어 LLM만 태운다.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from ..config import get_settings
from ..db.client import UserClient
from . import app_settings

logger = logging.getLogger("nodi.question_coach")
settings = get_settings()

# ---------------------------------------------------------------------------
# 방향 목록
#
# 앞의 다섯은 사용자가 정했다(정의·원인·비교·과정·응용). 뒤의 셋은 제안이다 —
# **더 높은 사고로 밀어 올리는 것**을 골랐다(D138의 Constructive 등급):
#
#   예시  추상을 구체로 내린다. 중·고등 학생이 가장 자연스럽게 잡는 다음 걸음이다.
#   근거  "어떻게 아는가" — 사실 암기와 과학적 사고를 가르는 질문이다.
#   한계  "언제 안 통하는가" — 개념의 경계를 묻는다. 제일 어렵고 제일 값지다.
#
# 여덟을 넘기지 않는다. 목록이 길어지면 모델이 아무거나 하나 골라 붙이고,
# 학생 화면에는 뜻이 겹치는 낱말이 나란히 뜬다.
# ---------------------------------------------------------------------------
DIRECTIONS: tuple[str, ...] = (
    "정의",
    "원인",
    "비교",
    "과정",
    "응용",
    "예시",
    "근거",
    "한계",
)

_SYSTEM = (
    "너는 중·고등학생의 **질문 습관**을 돕는 도우미다.\n"
    "학생이 한 주제를 이어 물어 온 카드들을 읽고, 지금까지 어떤 방향으로 "
    "물었는지와 아직 안 물은 방향을 고른다.\n\n"
    "방향은 이 여덟 중에서만 고른다: " + " · ".join(DIRECTIONS) + "\n\n"
    "⚠️ **질문 문장을 절대 쓰지 마라.** 네가 질문을 써 주면 학생이 그걸 베끼고, "
    "그러면 이 기능이 하려는 일(스스로 질문하기)이 무너진다. 너는 방향 낱말과 "
    "주제만 말한다.\n\n"
    "형식 — 이 세 줄만 출력한다. 설명·인사·마크다운 금지:\n"
    "주제: <이 브랜치가 다루는 것 한 낱말>\n"
    "지금: <물어 온 방향들, 쉼표로. 1개 이상>\n"
    "다음: <아직 안 물은 방향들, 쉼표로. 1개 이상>\n\n"
    "다음 중 하나면 세 줄 대신 `중단: <이유>` 한 줄만 출력한다:\n"
    "- 여덟 방향을 이미 다 물었다\n"
    "- 이 주제가 여덟 방향으로 나눌 성질이 아니다(감상·창작·잡담 등)\n"
)


#: 다시 말을 걸기까지 더 필요한 카드 수 (n + REARM_GAP).
#
# ⚠️ **판정은 프론트가 한다**(`lib/canvas2/questionCoach.ts`의 같은 이름 상수).
# 여기 있는 이유는 admin 콘솔이 "재발동까지 몇 장"을 보여 줘야 하기 때문이고
# (사용자 지시 2026-08-06), 두 수가 갈리면 **콘솔이 거짓말을 한다** — 화면에도
# 로그에도 안 드러난다. 한쪽을 고치면 반드시 다른 쪽도 고친다(양쪽에 테스트).
REARM_GAP = 3


def _knob_defaults() -> tuple[int, str]:
    return settings.question_coach_min_cards, settings.question_coach_model


async def read_knobs() -> dict[str, Any]:
    """튜너블 (D62: admin 오버레이 > config 기본값).

    `min_cards`(n)만 관리자가 만진다. 재발동 간격 n+3은 n에서 파생되므로 따로
    두지 않는다 — 둘을 각각 만지게 하면 "3인데 왜 7에서 뜨지" 같은 조합이 생긴다.
    """
    overlay = await app_settings.get_overlay()
    n_default, model_default = _knob_defaults()
    return {
        "min_cards": app_settings.as_int(
            overlay, "question_coach_min_cards", n_default, 1, 20
        ),
        "enabled": app_settings.as_bool(
            overlay, "question_coach_enabled", settings.question_coach_enabled
        ),
        "model": app_settings.as_str(
            overlay, "question_coach_model", model_default
        ).strip()
        or None,
    }


def parse_reply(raw: str) -> dict[str, Any] | None:
    """모델 답 → `{topic, covered, suggest}` 또는 None(중단).

    **형식을 어기면 중단이다.** 억지로 살려 내면 반쪽짜리 문구가 학생에게
    간다 — "지금 에 대해서 만 질문하고 있어요" 같은 것이 실제로 나온다.
    """
    text = (raw or "").strip()
    if not text:
        return None
    topic, covered, suggest = "", [], []
    for line in text.splitlines():
        line = line.strip()
        # ⚠️ **중단은 어디에 있든 이긴다.**
        #
        # 처음에는 맨 앞만 봤다(`startswith`). 그런데 실물 모델은 세 줄을 쓰고
        # **그 뒤에** "중단: 여덟 방향을 이미 다 물었다"를 붙였다(실측
        # 2026-08-06, solar-pro2). 앞만 보면 그 중단을 못 보고 말풍선을 띄운다 —
        # 사용자 규칙("모든 방향을 물었으면 중단")이 조용히 깨지는 자리다.
        if line.startswith("중단"):
            return None
        head, _, rest = line.partition(":")
        value = rest.strip()
        if head == "주제":
            topic = value[:40]
        elif head == "지금":
            covered = _pick(value)
        elif head == "다음":
            suggest = _pick(value)
    # 사용자 규칙: 지금도 1개 이상, 다음도 1개 이상. 하나라도 비면 할 말이 없다.
    if not topic or not covered or not suggest:
        return None
    # 이미 물은 방향을 다시 권하면 학생이 "얘가 내 카드를 안 읽었네"로 읽는다.
    suggest = [d for d in suggest if d not in covered]
    if not suggest:
        return None
    return {"topic": topic, "covered": covered, "suggest": suggest[:3]}


def _pick(value: str) -> list[str]:
    """쉼표로 나눠 **아는 방향만** 남긴다(순서·중복 정리).

    모델이 '심화'처럼 없는 낱말을 지어낼 수 있다. 그대로 쓰면 학생에게 우리가
    정의하지 않은 말이 뜨고, 다음에 그 낱말을 다시 못 쓴다.
    """
    out: list[str] = []
    for part in value.replace("·", ",").split(","):
        word = part.strip().strip("'\"[]()").strip()
        if word in DIRECTIONS and word not in out:
            out.append(word)
    return out


#: 말풍선에 이름을 대는 방향 수 상한. 넘으면 "등"으로 줄인다.
COVERED_SHOWN = 4


def build_bubble(topic: str, covered: list[str], suggest: list[str]) -> str:
    """말풍선 문구. 사용자가 준 예시를 그대로 따른다.

    ## 자른 것을 자르지 않은 척하지 않는다

    두 줄에 낱말 여덟 개가 들어가면 아무도 안 읽어서 앞의 몇 개만 댄다. 그런데
    그냥 자르면 **다섯 개를 물은 학생에게 "네 개만 질문하고 있어요"**라고 하게
    된다(실측 2026-08-06: 광합성 브랜치에서 실제로 그랬다). 작은 거짓말이지만
    학생은 자기 카드를 안다 — 한 번 어긋나면 이 말풍선을 안 믿는다.
    """
    shown = covered[:COVERED_SHOWN]
    cov = ", ".join(f"'{d}'" for d in shown)
    if len(covered) > len(shown):
        cov += " 등"
    sug = ", ".join(f"'{d}'" for d in suggest)
    return (
        f"지금 {topic}에 대해서 {cov}만 질문하고 있어요\n"
        f"질문의 방향성을 {sug}(으)로 잡아보는 건 어떨까요?"
    )


def build_hint(topic: str, suggest: list[str]) -> str:
    """입력창 위에 뜨는 한 줄.

    **여기서도 질문 문장을 만들지 않는다.** 방향을 풀어 쓸 뿐이다 — 학생이
    복사해 붙일 수 있는 문장이 되는 순간 이 기능은 반대로 작동한다.
    """
    parts = " 또는 ".join(f"{d} 방향의 질문" for d in suggest)
    return f"{topic}에 대해서 {parts}을 직접 만들어 보세요."


async def analyse(
    client: UserClient, item_ids: list[str], *, model: str | None
) -> dict[str, Any] | None:
    """브랜치의 카드들을 읽고 방향을 판정한다. 말할 것이 없으면 None.

    카드 본문은 **클라이언트가 보낸 것을 안 쓴다** — id만 받고 RLS로 다시 읽는다
    (D104·D178과 같은 계약). 사용자가 보낸 문자열은 검증 대상이지 근거가 아니다.
    """
    if not item_ids:
        return None
    rows = await client.select(
        "canvas_items",
        {
            "select": "id,title,body,tag,seq,data",
            "id": f"in.({','.join(item_ids)})",
            "order": "seq.asc",
        },
    )
    if not rows:
        return None

    lines = []
    for i, r in enumerate(rows, start=1):
        asked = ((r.get("data") or {}).get("askedQuestion") or "").strip()
        title = (r.get("title") or "").strip()
        body = " ".join((r.get("body") or "").split())[:220]
        # 학생이 **무엇을 물었는지**가 방향 판정의 핵심이다. 답만 주면 모델이
        # 답의 성격(설명문)을 방향으로 읽는다.
        lines.append(
            f"{i}. 학생 질문: {asked or '(입력창 없이 이어 물음)'}\n"
            f"   답 제목: {title}\n   답 요약: {body}"
        )
    user = "\n".join(lines)

    try:
        raw = await _ask(user, model)
    except Exception:  # noqa: BLE001 - 코치는 채팅을 절대 막지 않는다
        logger.warning("질문 코치 판정 실패", exc_info=True)
        return None

    got = parse_reply(raw)
    if not got:
        return None
    got["bubble"] = build_bubble(got["topic"], got["covered"], got["suggest"])
    got["hint"] = build_hint(got["topic"], got["suggest"])
    return got


async def _ask(user_text: str, model: str | None) -> str:
    picked = (model or settings.upstage_chat_model).strip()
    if not settings.upstage_api_key:
        raise RuntimeError("UPSTAGE_API_KEY 없음")
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.post(
            f"{settings.upstage_base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {settings.upstage_api_key}"},
            json={
                "model": picked,
                "messages": [
                    {"role": "system", "content": _SYSTEM},
                    {"role": "user", "content": user_text},
                ],
                # 방향 낱말 몇 개면 된다. 길게 두면 모델이 설명을 붙인다.
                "max_tokens": 160,
                "temperature": 0.2,
            },
        )
        res.raise_for_status()
        data = res.json()
    return data["choices"][0]["message"].get("content") or ""


def json_dumps(value: Any) -> str:
    """로그용 — 한국어를 이스케이프하지 않는다."""
    return json.dumps(value, ensure_ascii=False)
