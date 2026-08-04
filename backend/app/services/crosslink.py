"""교차 세션 개념 연결 (D171).

학생이 어제 생명과학에서 한 이야기와 오늘 지구과학에서 하는 이야기가 이어져
있을 때 그 연결을 찾아 설명한다. 스펙:
`docs/superpowers/specs/2026-08-04-crosslink-design.md`.

`기억 연결(memory_link)`은 D107에서 한 번 제거됐다 — **아이디어가 나빠서가
아니라 그걸 만드는 UI 경로가 없어 언제나 빈 결과였기 때문**이다. 이번엔 그
입구(배지 + 펼침 설명 + 과거 대화로 돌아가기)를 함께 만든다.

어떤 실패든 링크를 만들지 않는다. 이 기능은 채팅을 막지 않고, 없어도 학습에
지장이 없다.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from ..config import get_settings
from . import app_settings, qdrant_store, solar, upstage

logger = logging.getLogger("nodi.crosslink")
settings = get_settings()

# 임베딩에 넣는 카드 본문 상한. 개념 카드는 보통 1천 자 안쪽이고, 길어져도
# 앞부분이 주제를 정한다.
_MAX_EMBED_CHARS = 2000
# 설명 프롬프트에 넣는 각 카드 본문 상한. 둘을 다 넣으므로 임베딩보다 짧게.
_MAX_PROMPT_CHARS = 900

_WS = re.compile(r"\s+")


def norm_tag(tag: str | None) -> str:
    """태그 비교용 정규화.

    태그는 세션마다 모델이 자유롭게 짓는다(D89). `"생명과학"`과 `"생명 과학"`은
    다른 문자열이라 그냥 비교하면 **표기만 다른 같은 주제가 필터를 통과한다** —
    "다른 과목과 연결됐다"며 같은 과목을 보여 주게 된다. 공백 제거 + 소문자화로
    그 구멍을 닫는다.
    """
    if not tag:
        return ""
    return _WS.sub("", str(tag)).lower()


def embed_text(item: dict[str, Any]) -> str:
    """색인·질의에 쓰는 텍스트. 제목이 주제를 가장 압축해 담으므로 앞에 둔다."""
    title = (item.get("title") or "").strip()
    body = (item.get("body") or "").strip()
    text = f"{title}\n{body}" if title else body
    return text[:_MAX_EMBED_CHARS].strip()


def allowed_space_kinds(current_space_kind: str) -> list[str]:
    """방향 규칙 (사용자 결정 2026-08-04).

    **학급 → 개인은 되고, 개인 → 학급은 안 된다.** 개인 공간의 사적인 대화가
    학급 맥락으로 새지 않게 하는 규칙이다.

    - 지금 카드가 개인 세션: 개인·학급 어디서든 가져온다
    - 지금 카드가 학급 세션: 학급 세션에서만 가져온다
    """
    if current_space_kind == "class":
        return ["class"]
    return ["personal", "class"]


def band_verdict(
    distance: float, lo: float, hi: float, always_on: bool = False
) -> tuple[str, str]:
    """거리 하나의 판정 → (verdict, 한국어 사유). 관리자 로그에 그대로 실린다.

    `always_on`(D172)이면 띠를 건너뛴다 — **테스트용이다.** 켜 둔 채로 두면
    "드물게 뜬다"는 이 기능의 성질이 사라진다.
    """
    if always_on:
        return "accepted", f"상시 켜기 — 띠를 무시하고 채택 (거리 {distance:.3f})"
    if distance < lo:
        return (
            "too_close",
            f"거리 {distance:.3f}가 바닥 {lo}보다 가깝다 — 융합이 아니라 중복",
        )
    if distance > hi:
        return "too_far", f"거리 {distance:.3f}가 천장 {hi}를 넘는다"
    return "accepted", f"띠 안 (거리 {distance:.3f})"


def in_band(distance: float, lo: float, hi: float) -> bool:
    """거리 띠 판정 (D171).

    상한 하나만 두면 목적과 어긋난다 — **너무 가까운 히트는 융합이 아니라
    중복**이다("어제도 광합성, 오늘도 광합성"). 바닥 아래는 같은 얘기라 버린다.
    """
    return lo <= distance <= hi


def build_explain_messages(
    cur: dict[str, Any], past: dict[str, Any]
) -> list[dict[str, Any]]:
    """두 카드가 왜·어떻게 이어지는지 설명하게 하는 프롬프트.

    **연결이 약하면 약하다고 말하게 둔다.** 억지로 이어 붙인 설명은 학생에게
    잘못된 개념을 심는다 — 그래서 "관련이 없으면 없다고 하라"를 명시하고,
    호출부는 그 신호를 보면 링크를 만들지 않는다.
    """
    cur_tag = (cur.get("tag") or "").strip() or "(분류 없음)"
    past_tag = (past.get("tag") or "").strip() or "(분류 없음)"
    return [
        {
            "role": "system",
            "content": (
                "너는 중·고등학생의 학습을 돕는 교사다. 학생이 서로 다른 시기에 "
                "공부한 두 개념이 어떻게 이어지는지 짚어 준다.\n"
                "규칙:\n"
                "- 한국어로, 2~3문장으로 짧게 쓴다.\n"
                "- **왜** 관련이 있는지와 **어떻게** 이어지는지를 함께 말한다.\n"
                "- 두 내용을 요약하지 마라. 학생은 이미 읽었다. 연결만 말한다.\n"
                "- 억지로 잇지 마라. 실제로 관련이 없으면 정확히 "
                'NO_LINK 라고만 답한다.'
            ),
        },
        {
            "role": "user",
            "content": (
                f"[지금 공부하는 것 — 분류: {cur_tag}]\n"
                f"{(cur.get('title') or '').strip()}\n"
                f"{(cur.get('body') or '')[:_MAX_PROMPT_CHARS].strip()}\n\n"
                f"[예전에 공부한 것 — 분류: {past_tag}]\n"
                f"{(past.get('title') or '').strip()}\n"
                f"{(past.get('body') or '')[:_MAX_PROMPT_CHARS].strip()}\n\n"
                "이 둘이 어떻게 이어지는지 설명해라."
            ),
        },
    ]


def parse_explanation(content: str) -> str:
    """모델 답에서 설명을 꺼낸다. 연결이 없다고 하면 빈 문자열."""
    text = (content or "").strip()
    if not text or "NO_LINK" in text.upper():
        return ""
    return text[:800]


async def read_knobs() -> dict[str, Any]:
    """튜너블 읽기 (D62: admin 오버레이 > config 기본값)."""
    overlay = await app_settings.get_overlay()
    return {
        "enabled": app_settings.as_bool(
            overlay, "crosslink_enabled", settings.crosslink_enabled
        ),
        "lo": app_settings.as_float(
            overlay,
            "crosslink_min_distance",
            settings.crosslink_min_distance,
            0.0,
            0.9,
        ),
        "hi": app_settings.as_float(
            overlay,
            "crosslink_max_distance",
            settings.crosslink_max_distance,
            0.0,
            0.9,
        ),
        "top_k": app_settings.as_int(
            overlay, "crosslink_top_k", settings.crosslink_top_k, 1, 50
        ),
        # D172: 켜면 거리 띠를 건너뛴다. 테스트용 — 켜 둔 채로 두면
        # "드물게 뜬다"는 이 기능의 성질이 사라진다.
        "always_on": app_settings.as_bool(
            overlay, "crosslink_always_on", settings.crosslink_always_on
        ),
    }


async def index_item(item: dict[str, Any], session: dict[str, Any]) -> bool:
    """개념 카드 하나를 Qdrant에 색인한다. 성공 여부를 돌려준다.

    포인트 id는 **item_id 그대로**다 — 같은 카드를 다시 색인하면 덮어써진다
    (학생이 카드를 고칠 수 있으므로 멱등해야 한다).

    페이로드는 식별자만 넣는다. 본문·제목은 넣지 않는다 — Qdrant는 신뢰
    경계가 아니다(불변식).
    """
    text = embed_text(item)
    if not text:
        return False
    vec = (await upstage.embed_passages([text]))[0]
    await qdrant_store.upsert(
        qdrant_store.COL_CANVAS_CONCEPTS,
        [
            {
                "id": str(item["id"]),
                "vector": vec,
                "payload": {
                    "item_id": str(item["id"]),
                    "session_id": str(item["session_id"]),
                    "owner_id": str(session["owner_id"]),
                    "tag_norm": norm_tag(item.get("tag")),
                    "space_kind": str(session.get("space_kind") or "personal"),
                },
            }
        ],
    )
    return True


async def explain(cur: dict[str, Any], past: dict[str, Any]) -> str:
    """두 카드의 연결 설명. 실패·무연결이면 빈 문자열."""
    try:
        comp = await solar.complete(
            build_explain_messages(cur, past), max_tokens=400
        )
        return parse_explanation((comp.message or {}).get("content") or "")
    except Exception:  # noqa: BLE001 - 설명 실패는 링크를 안 만드는 것으로 끝난다
        logger.warning("연결 설명 생성 실패 item=%s", cur.get("id"), exc_info=True)
        return ""
