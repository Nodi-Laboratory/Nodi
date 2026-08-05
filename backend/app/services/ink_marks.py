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
from typing import Any, NamedTuple

import httpx

from ..config import get_settings
from .figure_judge import image_data_uri

logger = logging.getLogger("nodi.ink_marks")
settings = get_settings()

# 설명이 길어지면 SOLAR 프롬프트에서 카드 본문을 밀어낸다. 표시 설명은
# 2~4문장이면 끝나는 내용이다.
NOTE_LIMIT = 1200

MARKS_SYSTEM = """너는 학생이 학습 화면에 그린 표시를 **한 문장으로 옮겨 적는** 도우미다.

화면에는 학습 카드가 번호 붙은 상자로 그려져 있고, 학생이 **빨간 펜**으로
동그라미·화살표·밑줄을 그렸다.

**어느 카드를 짚었는지는 아래에 이미 적혀 있다.** 네가 고르는 것이 아니다.
그림은 그것이 *어떻게* 그려졌는지 보라고 주는 것이다 — 카드 전체를 감쌌는지
한 구절만 감쌌는지, 어디에서 어디로 향하는지, 둘을 잇는 모양인지.

지켜야 할 것:
- 적힌 사실과 **다르게 말하지 마라.** 짚었다고 적힌 카드만 짚은 것이다.
- 카드 내용을 설명하지 마라. 요약도 하지 마라. 그건 다른 모델이 한다.
- 카드를 부를 때는 반드시 [카드 N] 형식으로 번호를 써라.
- 그림에서 확인되지 않는 것은 쓰지 마라. 지어내지 마라."""

# 형식 지시를 **맨 끝에 한 번 더** 둔다.
#
# 이게 없으면 모델이 형식을 통째로 무시한다 — 실측 2026-08-05(EXAONE-4.5-33B):
# 앞의 지시만으로는 800자짜리 마크다운 에세이가 나왔고 파싱이 통째로 실패했다.
# 그림을 본 직후의 **마지막 지시**가 이긴다.
MARKS_FORMAT = """지금부터 **한 줄만** 출력한다. 머리말·목록·굵은 글씨·이모지·구분선을 쓰지 마라.

설명: <빨간 표시가 무엇을 어떻게 짚었는지 한국어 2~3문장>"""

#: 기하가 센 표시 종류 → 사람 말. 프롬프트에 **사실로** 실어 준다.
MARK_WORDS = {
    "circled": "동그라미로 감쌌다",
    "pointed": "화살표·밑줄로 짚었다",
    "crossed": "빨간 선이 위를 스쳐 지나가기만 했다",
    "near": "표시가 닿지 않았다",
}
#: 짚은 것으로 보는 종류(프론트 `POINTING_KINDS`와 같아야 한다).
POINTING = ("circled", "pointed")


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
    # **자리를 함께 준다.** 번호를 상자에 잇는 단서가 배지 숫자뿐이면 모델이
    # 틀린다 — 비전 인코더가 그림을 줄이면 그 숫자가 뭉개지기 때문이다(실측
    # 2026-08-05: 내용은 맞히면서 번호만 틀렸다). 자리는 줄어들어도 남는다.
    def line(c: dict[str, Any]) -> str:
        head = f"{c['n']} = {(c.get('title') or '(제목 없음)')}"
        if c.get("where"):
            head += f" ({c['where']})"
        word = MARK_WORDS.get(str(c.get("mark") or ""), "")
        return f"{head} — {word}" if word else head

    roster = "\n".join(line(c) for c in cards)
    lines = [
        MARKS_SYSTEM,
        "",
        f"화면에 있는 카드와 **우리가 이미 판정한 표시**:\n{roster or '(없음)'}",
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
    # **형식 지시가 맨 끝이다.** 이 순서가 이 프롬프트의 전부다(MARKS_FORMAT 주석).
    lines += ["", MARKS_FORMAT]
    content.append({"type": "text", "text": "\n".join(lines)})
    # **메시지는 user 하나뿐이다** — system 역할을 쓰지 않는다.
    #
    # `figure_caption`이 이 서버에서 검증된 모양이 그것이고, 실측에서도 지시를
    # system에 두면 **묻혔다**(2026-08-05: 형식을 통째로 무시). 그림과 지시가
    # 한 턴에 붙어 있어야 한다.
    return [{"role": "user", "content": content}]


_NOTE_RE = re.compile(r"^\s*설명\s*[::]\s*", re.MULTILINE)


def parse_marks(content: str) -> str:
    """모델 출력 → 설명 한 문단.

    **번호는 더 이상 모델에게 묻지 않는다.** 어느 카드를 짚었는지는 프론트가
    기하로 정확히 센다(`inkScene.markOf`) — 모델은 불확실할 때 늘 1번을
    답했고(실측 2026-08-05) 그 오답이 그대로 SOLAR에 흘러갔다. 모델에게는
    모델만 할 수 있는 일을 남긴다: 그 표시가 무슨 뜻인지 문장으로 쓰기.

    형식을 어겨도 **버리지 않는다** — `설명:` 줄이 없으면 원문 전체를 쓴다.
    """
    text = (content or "").strip()
    if not text:
        return ""
    m = _NOTE_RE.search(text)
    note = text[m.end():].strip() if m else text
    return " ".join(note.split())[:NOTE_LIMIT] if note else ""


class MarksResult(NamedTuple):
    """표시 해석 결과 + **왜 그렇게 됐는지.**

    설명이 비는 갈래가 여럿인데(꺼짐·미설정·도식 없음·서버 오류) 결과만 보면
    구분이 안 된다. 관리자 실험실이 "표시가 왜 안 읽혔나"에 답하려면 그
    이유가 결과와 함께 와야 한다 — 개념 연결(D172)이 기각 사유를 남긴 것과
    같은 이유다.

    NamedTuple이라 `pointed, note, status = result`로 그냥 풀린다.
    """

    note: str
    #: ok · off(킬 스위치) · unconfigured(주소·키 없음) · no_scene(도식 안 옴)
    #: · error(서버가 안 받음)
    status: str



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
) -> MarksResult:
    """표시를 읽는다. **어떤 실패든 빈 설명으로 강등한다**(status가 이유를 준다).

    질문을 막지 않는 것이 이 함수의 계약이다 — 표시 해석은 곁들이고, 질문
    자체는 손글씨(OCR)가 나른다.

    `client`를 주면 그것을 쓴다(`figure_caption.caption_one`과 같은 규약) —
    테스트가 `httpx.MockTransport`로 요청을 가로챌 수 있어야 한다. 안 주면
    타임아웃이 걸린 클라이언트를 하나 만들어 쓰고 닫는다.
    """
    if not settings.ink_vlm_enabled:
        return MarksResult("", "off")
    if not (settings.judge_base_url.strip() and settings.judge_api_key.strip()):
        return MarksResult("", "unconfigured")
    if not scene_png:
        return MarksResult("", "no_scene")

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
        return MarksResult("", "error")

    return MarksResult(parse_marks(content), "ok")
