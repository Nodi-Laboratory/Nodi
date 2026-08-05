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

MARKS_SYSTEM = """너는 학생이 학습 화면에 그린 표시를 **한국어 문장으로 옮겨 적는** 도우미다.

화면에는 학습 카드가 번호 붙은 상자로 그려져 있고, 학생이 **빨간 펜**으로
동그라미·화살표·밑줄·묶음표 같은 표시를 그렸다.

**표시가 무엇을 어느 카드에 했는지는 아래에 이미 적혀 있다.** 네가 고르는 것이
아니다. 그림은 그것이 *어떻게* 그려졌는지 보라고 주는 것이다 — 카드 전체를
감쌌는지 한 구절만 감쌌는지, 어느 쪽에서 어느 쪽으로 향하는지, 몇 번을
덧그었는지, 도판의 어느 부분에 닿았는지.

지켜야 할 것:
- 적힌 사실과 **다르게 말하지 마라.** 적힌 것이 전부다.
- 카드 내용을 설명하지 마라. 요약도 하지 마라. 그건 다른 모델이 한다.
- 카드를 부를 때는 반드시 [카드 N] 형식으로 번호를 써라.
- 그림에서 확인되지 않는 것은 쓰지 마라. 지어내지 마라."""

# 형식 지시를 **맨 끝에 한 번 더** 둔다.
#
# 이게 없으면 모델이 형식을 통째로 무시한다 — 실측 2026-08-05(EXAONE-4.5-33B):
# 앞의 지시만으로는 800자짜리 마크다운 에세이가 나왔고 파싱이 통째로 실패했다.
# 그림을 본 직후의 **마지막 지시**가 이긴다.
#
# 무엇을 담을지도 여기서 못 박는다. "표시를 설명하라"만 주면 모델이 아는 말
# ("왼쪽 위에 있다")로 때운다 — 담아야 할 것을 셋으로 쪼개 주면 그만큼 쓴다.
MARKS_FORMAT = """지금부터 **한 줄만** 출력한다. 머리말·목록·굵은 글씨·이모지·구분선을 쓰지 마라.

그 한 줄에 셋이 들어가야 한다: (1) 표시가 무슨 모양인지, (2) 어느 카드에
어떻게 닿았는지 — 감쌌는지 끝이 멈췄는지 스쳐 갔는지, (3) 그래서 학생이
묻는 대상이 무엇인지.

설명: <빨간 표시를 옮겨 적은 한국어 2~4문장>"""

#: 기하가 센 표시 종류 → 사람 말. 프롬프트에 **사실로** 실어 준다.
MARK_WORDS = {
    "circled": "동그라미가 이 카드를 감쌌다",
    "within": "이 카드 안에 표시를 그었다",
    "pointed": "표시의 끝이 이 카드를 가리킨다",
    "linked": "표시가 이 카드에서 출발해 다른 데로 갔다",
    "crossed": "표시가 위를 스쳐 지나가기만 했다",
    "near": "표시가 닿지 않았다",
}
#: 짚은 것으로 보는 종류(프론트 `POINTING_KINDS`와 같아야 한다).
#:
#: `linked`는 뺀다 — 화살표가 카드 1에서 카드 3으로 갔다면 학생이 묻는 것은
#: 카드 3이다. 둘 다 대상으로 치면 SOLAR가 둘 다 설명한다.
POINTING = ("circled", "within", "pointed")

#: 표시 모양 → 사람이 부르는 이름. 프론트 `GestureShape`와 같은 열쇠다.
SHAPE_WORDS = {
    "circle": "동그라미",
    "arrow": "화살표",
    "underline": "밑줄",
    "line": "선",
    "bracket": "ㄷ자로 꺾인 묶음표",
    "scribble": "여러 번 덧그은 선",
}

# 숫자를 한국어로 읽었을 때 받침이 있는 것 — 조사를 고르는 데 쓴다.
# 끝자리만 보면 된다(11=십일, 20=이십 … 끝자리가 읽기의 끝이다).
_JONG = frozenset("136780")
_RIEUL = frozenset("178")  # 일·칠·팔 — ㄹ받침이라 "으로"가 아니라 "로"


def _tag(n: int) -> str:
    return f"[카드 {n}]"


def _join(ns: list[int], particle) -> str:
    """번호 목록 → "[카드 1]과 [카드 3]을" 같은 한 덩어리.

    조사를 맞추는 이유는 이 글을 읽는 것이 **작은 모델**이기 때문이다. 어색한
    한국어는 그대로 어색한 한국어로 되받아 적히고, 그 문장이 SOLAR에 간다.
    """
    if not ns:
        return ""
    head = "".join(
        _tag(n) + ("과 " if str(n)[-1] in _JONG else "와 ") for n in ns[:-1]
    )
    return head + _tag(ns[-1]) + particle(ns[-1])


def _eul(n: int) -> str:
    return "을" if str(n)[-1] in _JONG else "를"


def _ro(n: int) -> str:
    d = str(n)[-1]
    return "으로" if d in _JONG and d not in _RIEUL else "로"


def _eseo(_n: int) -> str:
    return "에서"


def _neun(n: int) -> str:
    return "은" if str(n)[-1] in _JONG else "는"


def _has_jong(word: str) -> bool:
    """마지막 글자에 받침이 있나 — 한글 음절은 (코드 − 0xAC00) % 28로 안다."""
    if not word:
        return False
    c = ord(word[-1])
    return 0xAC00 <= c <= 0xD7A3 and (c - 0xAC00) % 28 != 0


def _w(word: str, has: str, no: str) -> str:
    """모양 이름에 붙일 조사. "밑줄가"·"밑줄를"이 나오면 안 된다."""
    return word + (has if _has_jong(word) else no)


def gesture_line(g: dict[str, Any]) -> str:
    """표시 하나 → 한국어 한 줄.

    **카드가 아니라 표시가 주어다.** 카드마다 낱말 하나만 주면 "화살표가
    [카드 1]에서 [카드 3]으로 향한다"를 말할 방법이 없다 — 방향은 카드 둘
    사이의 관계라 어느 한 카드에도 안 딸린다. 실측 2026-08-05: 카드 낱말만
    줬을 때 모델이 쓴 문장은 "왼쪽 카드를 가리킨다" 수준에서 멈췄다.
    """
    shape = SHAPE_WORDS.get(str(g.get("shape") or ""), "표시")
    enc = g.get("encloses") or []
    win = g.get("within") or []
    pts = g.get("points") or []
    frm = g.get("from") or []
    crs = g.get("crosses") or []

    ga = _w(shape, "이", "가")
    eul = _w(shape, "을", "를")

    parts: list[str] = []
    if enc:
        parts.append(f"{ga} {_join(enc, _eul)} 통째로 감쌌다.")
    if win:
        parts.append(f"{_join(win, _eul)} 두른 상자 **안쪽에** {eul} 그었다.")
    if pts and frm:
        parts.append(f"{ga} {_join(frm, _eseo)} 시작해 {_join(pts, _ro)} 향한다.")
    elif pts:
        parts.append(f"{shape}의 끝이 {_join(pts, _eul)} 가리키며 거기서 멈췄다.")
    elif frm:
        parts.append(f"{ga} {_join(frm, _eseo)} 시작해 카드가 없는 쪽으로 나간다.")
    if crs:
        parts.append(f"{_join(crs, _neun)} 위를 스쳐 지나가기만 하고 멈추지 않는다.")
    if not parts:
        parts.append(f"{eul} 그렸지만 어느 카드에도 닿지 않았다.")
    return " ".join(parts)


def build_marks_messages(
    cards: list[dict[str, Any]],
    scene_uri: str,
    figure_uri: str | None,
    figure_n: int | None,
    gestures: list[dict[str, Any]] | None = None,
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
        f"화면에 있는 카드:\n{roster or '(없음)'}",
    ]

    shots = gestures or []
    if shots:
        drawn = "\n".join(f"- {gesture_line(g)}" for g in shots)
        lines += ["", f"학생이 그린 표시 {len(shots)}개 (우리가 이미 판정했다):\n{drawn}"]

    # **결론을 한 줄로 못 박는다.** 위의 사실들에서 이걸 유도하게 두면 모델이
    # 틀린다 — 유도가 필요 없게 답을 적어 준다.
    targets = [c["n"] for c in cards if str(c.get("mark") or "") in POINTING]
    if targets:
        lines += ["", f"→ 학생이 묻는 대상: {', '.join(_tag(n) for n in targets)}"]
    else:
        lines += ["", "→ 어느 카드도 확실히 짚지 않았다. 그렇게 말하라."]

    lines += ["", "첫 번째 그림이 화면 전체다."]
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
    gestures: list[dict[str, Any]] | None = None,
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
        gestures,
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
