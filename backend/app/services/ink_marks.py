"""펜 표시 해석 (D178) — 동그라미·화살표가 어느 카드를 가리키는지 읽는다.

D176은 손글씨를 글자로 바꿨다. 그런데 학생이 하는 일은 그것만이 아니다 —
**카드를 동그라미 치고, 화살표를 긋고, 그 끝에 질문을 쓴다.** "이거에 대해서
더 자세하게 설명해줘"만 SOLAR에 보내면 **"이거"가 사라진다.** 이 모듈이 그
지시대상을 말로 바꾼다.

## judge_* 계열을 그대로 재사용한다

`figure_caption`과 같은 창구(OpenAI 호환 비전, 기본 EXAONE-4.5-33B)를 쓴다.
새 인프라가 없고, 도판 캡션과 같은 GPU에 이미 떠 있다. 손글씨 OCR은 다른
GPU(VARCO)라 **둘이 실제로 병렬로 돈다.**

## JSON을 요구하지 않는다

스키마를 물리면 실패 갈래가 하나 늘고, 우리가 필요한 것은 결국 **SOLAR에
그대로 넘길 한국어 한 문단**이다. 대신 형식을 두 줄로 못 박고, 파싱은
`가리킴:` 한 줄만 한다. **모델이 형식을 어겨도 설명은 버리지 않는다.**

## 실패는 침묵으로 강등된다

`read_marks`는 어떤 예외에서도 `(None, "")`을 준다. 표시 해석은 **곁들이**고
질문 자체는 손글씨(OCR)다 — RAG가 채팅을 막지 않는 것과 같은 성질이다.
다만 **조용히 넘기지는 않는다**: 실패는 로그에 남긴다(D135의 교훈 — 실패가
아무 흔적도 안 남기면 기능이 꺼진 줄 모른다).
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from ..config import get_settings
from .figure_judge import image_data_uri

logger = logging.getLogger("nodi.ink_marks")
settings = get_settings()

# 설명이 길어지면 SOLAR 프롬프트에서 카드 본문을 밀어낸다. 표시 설명은
# 2~4문장이면 끝나는 내용이다.
NOTE_LIMIT = 1200

MARKS_SYSTEM = """너는 학생이 학습 화면에 그린 표시를 읽는 도우미다.

화면에는 학습 카드가 번호가 붙은 상자로 그려져 있고, 학생이 **빨간 펜**으로
그린 표시(동그라미·화살표·밑줄·손글씨)가 얹혀 있다.

너의 일은 **빨간 표시가 무엇을 가리키는지**를 말하는 것 하나뿐이다.

지켜야 할 것:
- 카드 내용을 설명하지 마라. 요약도 하지 마라. 그건 다른 모델이 한다.
- 빨간 표시와 닿지 않은 카드는 **닿지 않았다고 명시해서 말하라.**
- 카드를 부를 때는 반드시 [카드 N] 형식으로 번호를 써라. 제목만 쓰지 마라.
- 확실하지 않으면 확실하지 않다고 말하라. 지어내지 마라.

출력은 정확히 두 줄이다:

가리킴: <화살표가 가리키는 카드 번호 하나. 없으면 '없음'>
설명: <빨간 표시가 무엇을 어떻게 가리키는지 한국어 2~4문장>"""


def build_marks_messages(
    cards: list[dict[str, Any]],
    scene_uri: str,
    figure_uri: str | None,
    figure_n: int | None,
) -> list[dict]:
    """표시 해석 요청 메시지.

    **카드 명부를 텍스트로도 준다.** 이미지 속 작은 제목을 읽게 시키면 틀린다 —
    그림에서 풀 문제는 **기하뿐**이고, 번호↔제목 대응은 우리가 이미 안다.

    도판 확대본은 표시가 도판에 닿았을 때만 온다. 그때 두 번째 그림이 무엇인지
    말해 주지 않으면 모델이 별개의 장면으로 읽어 표시를 두 번 센다.
    """
    roster = "\n".join(
        f"{c['n']} = {(c.get('title') or '(제목 없음)')}" for c in cards
    )
    lines = [
        f"화면에 있는 카드:\n{roster or '(없음)'}",
        "",
        "첫 번째 그림이 화면 전체다.",
    ]
    content: list[dict] = [{"type": "image_url", "image_url": {"url": scene_uri}}]
    if figure_uri and figure_n:
        content.append({"type": "image_url", "image_url": {"url": figure_uri}})
        lines.append(
            f"두 번째 그림은 [카드 {figure_n}] 도판을 크게 본 것이다. "
            "빨간 표시의 위치는 첫 번째 그림과 같다."
        )
    content.append({"type": "text", "text": "\n".join(lines)})
    return [
        # **system content는 문자열이다** — 파트 배열이 아니라.
        # `figure_caption`은 system 역할을 아예 쓰지 않는 것으로 이 서버(llama.cpp
        # + mmproj)에서 검증된 유일한 형태다. 배열 content는 서버마다 지원이
        # 갈리고, **로컬에는 비전 모델이 없어 우리가 확인할 수 없는 경로다.**
        # 확인할 수 없으면 넓은 쪽이 아니라 좁은 쪽을 고른다.
        {"role": "system", "content": MARKS_SYSTEM},
        {"role": "user", "content": content},
    ]


_POINT_RE = re.compile(r"^\s*가리킴\s*[::]\s*(.+?)\s*$", re.MULTILINE)
_NOTE_RE = re.compile(r"^\s*설명\s*[::]\s*", re.MULTILINE)


def parse_marks(content: str, card_count: int | None = None) -> tuple[int | None, str]:
    """모델 출력 → (가리킨 번호, 설명).

    형식을 어겨도 **설명은 버리지 않는다** — `설명:` 줄이 없으면 원문 전체를
    설명으로 본다. 번호만 못 얻을 뿐 SOLAR에 넘길 내용은 그대로다.

    `card_count`를 주면 명부 밖 번호를 버린다. 카드가 3장인데 모델이 9를
    말하면 매핑이 어긋난 것이고, **조용히 틀리느니 번호를 포기한다**(설명은
    남는다 — 거기 [카드 N]이 들어 있으면 SOLAR가 읽는다).
    """
    text = (content or "").strip()
    if not text:
        return None, ""

    pointed: int | None = None
    m = _POINT_RE.search(text)
    if m:
        raw = m.group(1).strip()
        num = re.search(r"-?\d+", raw)
        if num:
            v = int(num.group())
            if v >= 1 and (card_count is None or v <= card_count):
                pointed = v

    n = _NOTE_RE.search(text)
    note = text[n.end():].strip() if n else text
    return pointed, " ".join(note.split())[:NOTE_LIMIT] if note else ""


def is_configured() -> bool:
    """비전 창구가 설정돼 있나. 안 돼 있으면 부르지 않는다(오류가 아니다)."""
    return bool(
        settings.ink_vlm_enabled
        and settings.judge_base_url.strip()
        and settings.judge_api_key.strip()
    )


async def read_marks(
    cards: list[dict[str, Any]],
    scene_png: bytes,
    figure_png: bytes | None = None,
    figure_n: int | None = None,
    *,
    client: httpx.AsyncClient | None = None,
) -> tuple[int | None, str]:
    """표시를 읽는다. **어떤 실패든 `(None, "")`으로 강등한다.**

    질문을 막지 않는 것이 이 함수의 계약이다 — 표시 해석은 곁들이고, 질문
    자체는 손글씨(OCR)가 나른다.

    `client`를 주면 그것을 쓴다(`figure_caption.caption_one`과 같은 규약) —
    테스트가 `httpx.MockTransport`로 요청을 가로챌 수 있어야 한다. 안 주면
    타임아웃이 걸린 클라이언트를 하나 만들어 쓰고 닫는다.
    """
    if not is_configured() or not scene_png:
        return None, ""

    messages = build_marks_messages(
        cards,
        image_data_uri(scene_png, "png"),
        image_data_uri(figure_png, "png") if figure_png else None,
        figure_n,
    )
    payload = {
        "model": settings.judge_model,
        "messages": messages,
        # 두 줄이면 끝나는 출력이다. 넉넉히 주되 폭주는 막는다.
        "max_tokens": 400,
        # figure_caption과 같은 EXAONE 4.5 권장값 — thinking off로 빠른 생성.
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
            async with httpx.AsyncClient(
                timeout=settings.ink_vlm_timeout_seconds
            ) as owned:
                content = await _call(owned)
    except Exception:  # noqa: BLE001 - 표시 해석 실패는 질문을 막지 않는다
        logger.warning("펜 표시 해석 실패 — 표시 없이 질문을 보낸다", exc_info=True)
        return None, ""

    return parse_marks(content, card_count=len(cards))
