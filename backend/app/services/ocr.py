"""손글씨 OCR 클라이언트 — VARCO-VISION-2.0-1.7B-OCR (D176).

프롬프트창의 펜 입력판(`PenPad.tsx`)이 흰 종이에 검은 획으로 그린 PNG를 보내면,
이 모듈이 OCR 서버의 `POST /ocr`로 넘겨 **평문 한 덩어리**를 돌려준다.

## 왜 프론트가 직접 부르지 않나

OCR 서버는 **인증이 없고 CORS가 모두 열려 있다**. 브라우저에서 바로 부르면
주소가 곧 공개 GPU 창구가 된다(학생 브라우저 = 인터넷 아무나). 백엔드를 거치면
로그인 검사가 앞에 서고, 주소도 서버 안에만 남는다.

## 줄은 좌표로 되살린다 (D177)

서버의 `text`는 조각을 **공백으로 이어 붙인** 결과라 여러 줄로 쓴 글씨가 한 줄로
뭉갠다. 캔버스 전체가 종이가 되면서(D176) 학생은 여러 줄로 쓴다 — 그걸 한 줄로
합치면 문장이 뒤엉킨다.

그래서 `boxes`의 y로 줄을 갈라 복원한다(`lines_from_boxes`). 박스가 없거나
해석이 안 되면 `text`로 떨어진다 — 줄이 뭉개질지언정 글자는 살린다.

## 혼잡은 우리 쪽에서 막는다 (D177)

모델 서버는 **GPU 락으로 요청을 직렬 처리한다**(문서). 더 밀어 넣어도 처리량은
안 늘고 모두의 대기만 길어진다. 그래서 들어가는 수를 세마포어로 막고, 자리를
못 잡으면 **빨리 포기하고 "붐빈다"고 알린다** — 학생을 한참 세워 두고 결국
실패시키는 것보다 낫다.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from ..config import get_settings
from . import app_settings

logger = logging.getLogger("nodi.ocr")
settings = get_settings()


class OcrUnavailable(RuntimeError):
    """설정이 없거나 꺼져 있다 — 고장이 아니라 **아직/지금은 없음**이다."""


class OcrUpstreamError(RuntimeError):
    """모델 서버가 응답하지 않거나 오류를 냈다."""


class OcrBusy(RuntimeError):
    """지금 GPU 앞이 붐빈다 — 고장이 아니라 **잠깐 기다려야 함**이다."""


# 동시에 들어가는 요청 수를 우리 쪽에서 막는다. 설정이 바뀌면 다시 만든다
# (부팅 시 한 번 읽고 마는 값이 아니라 admin 노브다).
_gate: asyncio.Semaphore | None = None
_gate_size = 0


def _acquire_gate(size: int) -> asyncio.Semaphore:
    """동시 요청 문. **크기는 호출부가 준다** — 노브를 읽으려면 async여야 한다."""
    global _gate, _gate_size
    size = max(1, size)
    if _gate is None or _gate_size != size:
        _gate = asyncio.Semaphore(size)
        _gate_size = size
    return _gate


def resolve_base_url() -> str:
    """OCR 서버 주소. 빈 문자열이면 설정되지 않은 것이다.

    `OCR_BASE_URL`이 있으면 그대로 쓰고, 없으면 **judge 호스트에서 유도한다**
    (사용자 지시 2026-08-04). judge는 `http://호스트:30119/v1` 꼴이므로 경로와
    포트를 떼고 `ocr_port`를 붙인다 — 두 모델이 같은 기계에 떠 있다는 사실이
    유도의 근거다. 다른 기계로 옮기는 순간 이 가정이 깨지므로 그때는
    `OCR_BASE_URL`을 명시한다.

    judge 주소도 비어 있으면 **추측하지 않는다** — D97이 judge_base_url의
    기본값을 없앤 것과 같은 이유다. 기본값이 엉뚱한 서비스를 가리키면 요청이
    조용히 남의 집으로 간다.
    """
    explicit = settings.ocr_base_url.strip().rstrip("/")
    if explicit:
        return explicit

    judge = settings.judge_base_url.strip()
    if not judge:
        return ""
    parts = urlsplit(judge)
    if not parts.scheme or not parts.hostname:
        return ""
    return urlunsplit((parts.scheme, f"{parts.hostname}:{settings.ocr_port}", "", "", ""))


async def read_knobs() -> dict[str, Any]:
    """튜너블 읽기 (D62: admin 오버레이 > config 기본값).

    ## 왜 생겼나

    예전에는 `settings.*`를 **직접** 읽었다. 이 키들은 콘솔 스펙에 있고
    `ocr_enabled`는 **모델 서버 점검 중에 끄라고 만든 킬 스위치**인데, 관리자가
    꺼도 서버는 계속 불렀다(점검 2026-08-06). 장애 때 쓰려고 만든 손잡이가
    정작 그때 안 먹는 상태였다.

    D62가 말하는 것은 오버레이가 config를 이긴다는 것이고, 그러려면 여기서
    **읽어야** 한다. 안 읽으면 노브가 아니라 장식이다.
    """
    overlay = await app_settings.get_overlay()
    return {
        "enabled": app_settings.as_bool(overlay, "ocr_enabled", settings.ocr_enabled),
        "timeout": app_settings.as_int(
            overlay, "ocr_timeout_seconds", settings.ocr_timeout_seconds, 5, 300
        ),
        "max_concurrent": app_settings.as_int(
            overlay, "ocr_max_concurrent", settings.ocr_max_concurrent, 1, 16
        ),
        "queue_timeout": app_settings.as_int(
            overlay,
            "ocr_queue_timeout_seconds",
            settings.ocr_queue_timeout_seconds,
            1,
            120,
        ),
        "max_new_tokens": app_settings.as_int(
            overlay, "ocr_max_new_tokens", settings.ocr_max_new_tokens, 16, 2048
        ),
    }


def missing_config() -> list[str]:
    """호출에 필요한데 비어 있는 **env** (없으면 빈 리스트).

    ⚠️ 킬 스위치(`ocr_enabled`)는 여기서 안 본다 — 그건 admin 노브라 오버레이를
    타야 하고(`read_knobs`), 이 함수는 동기라 못 읽는다. **둘은 성질이 다르다:**
    주소는 배포가 정하고 킬 스위치는 관리자가 지금 끈다. 껐다고 "설정이 빠졌다"고
    말하면 관리자가 env를 뒤지게 된다.
    """
    missing: list[str] = []
    if not resolve_base_url():
        missing.append("OCR_BASE_URL")  # 또는 유도의 출처인 JUDGE_BASE_URL
    return missing


async def is_available() -> bool:
    """지금 부를 수 있나 — 주소가 있고 **꺼져 있지 않은가.**

    `is_configured()`(주소만)와 나눈 이유는 위 docstring과 같다. 화면이 501을
    낼지 말지는 이쪽이 정한다.
    """
    if not resolve_base_url():
        return False
    return (await read_knobs())["enabled"]


def is_configured() -> bool:
    """부를 수 있는 상태인가. 도달성(네트워크)까지는 보지 않는다 — judge와 같은 방침."""
    return not missing_config()


def clean_text(raw: str) -> str:
    """모델이 준 평문을 입력창에 넣을 한 줄로.

    조각 사이 공백이 겹치거나 줄바꿈이 섞여 오는 경우가 있어 공백을 하나로
    모은다. **글자는 고치지 않는다** — 맞춤법 교정은 우리 일이 아니고, 학생이
    쓴 것과 다른 글자가 들어가면 그게 더 나쁘다.
    """
    return " ".join((raw or "").split())


def lines_from_boxes(boxes: Any) -> str:
    """문자 박스들 → **줄이 살아 있는** 텍스트 (D177).

    서버는 어절마다 `bbox = [x1, y1, x2, y2]`(0~1 정규화)를 준다. 같은 줄에
    쓴 글씨는 y 구간이 서로 겹치므로, **겹치면 같은 줄**로 묶고 줄 안에서는
    x로 정렬한다.

    임계를 "y 중심 차이 < 상수"로 두지 않는 이유: 글씨 크기가 제각각이라
    고정 상수는 큰 글씨를 쪼개고 작은 글씨를 합친다. 대신 **겹친 높이가 더
    낮은 쪽 높이의 절반을 넘는가**로 본다 — 크기에 따라 저절로 조정된다.

    박스가 없거나 형태가 다르면 빈 문자열을 준다 — 호출부가 `text`로 떨어진다.
    """
    if not isinstance(boxes, list) or not boxes:
        return ""

    items: list[tuple[float, float, float, str]] = []  # (y1, y2, x1, text)
    for b in boxes:
        if not isinstance(b, dict):
            continue
        bbox = b.get("bbox")
        text = b.get("text")
        if not isinstance(bbox, (list, tuple)) or len(bbox) < 4:
            continue
        if not isinstance(text, str) or not text.strip():
            continue
        try:
            x1, y1, _x2, y2 = (float(bbox[0]), float(bbox[1]),
                               float(bbox[2]), float(bbox[3]))
        except (TypeError, ValueError):
            continue
        if y2 < y1:
            y1, y2 = y2, y1
        items.append((y1, y2, x1, text.strip()))

    if not items:
        return ""

    items.sort(key=lambda it: (it[0], it[2]))
    rows: list[list[tuple[float, float, float, str]]] = [[items[0]]]
    for it in items[1:]:
        row = rows[-1]
        # 줄의 세로 구간은 지금까지 담은 것들의 합집합이다 — 첫 글자만 보면
        # 줄 중간에 큰 글자가 오는 순간 줄이 갈라진다.
        top = min(r[0] for r in row)
        bottom = max(r[1] for r in row)
        overlap = min(bottom, it[1]) - max(top, it[0])
        shorter = min(bottom - top, it[1] - it[0])
        if shorter > 0 and overlap > shorter * 0.5:
            row.append(it)
        else:
            rows.append([it])

    out: list[str] = []
    for row in rows:
        row.sort(key=lambda it: it[2])
        line = " ".join(r[3] for r in row).strip()
        if line:
            out.append(line)
    return "\n".join(out)


def merge_layout(text: str, boxes: Any) -> str:
    """서버의 한 줄 `text`에 좌표로 복원한 **줄바꿈만** 얹는다 (D177).

    줄을 살리는 것이 목적이지 글자를 바꾸는 것이 아니다. 그래서 박스로 만든
    결과가 `text`와 **글자 구성이 정확히 같을 때만** 채택한다.

    왜 이 검사가 필요한가: `text`는 서버가 박스들을 이어 붙인 값이라 보통은
    같지만, 둘이 어긋나면(파싱이 일부만 되거나 계약이 바뀌면) 박스 쪽이 **짧다**.
    그대로 쓰면 학생이 쓴 글의 일부가 조용히 사라진다 — 줄이 뭉개지는 것보다
    글자를 잃는 것이 훨씬 나쁘다.

    비교는 공백을 뺀 글자의 다중집합으로 한다(순서는 줄 나눔으로 바뀌니까).
    """
    flat = clean_text(text)
    laid_out = lines_from_boxes(boxes)
    if not laid_out:
        return flat
    if sorted(laid_out.split()) != sorted(flat.split()):
        logger.info("ocr 좌표 복원과 text가 불일치 — text를 쓴다")
        return flat
    return laid_out


async def recognize(
    image: bytes,
    *,
    filename: str = "handwriting.png",
    content_type: str = "image/png",
) -> str:
    """손글씨 PNG → 평문. 실패는 예외로 올린다(빈 문자열로 뭉개지 않는다).

    `upscale_image`는 서버 기본값(true)에 맡긴다 — 입력판은 화면 크기라 긴 변이
    2304px에 한참 못 미치고, 문서가 "업스케일해야 정확도가 크게 오른다"고
    명시한다.
    """
    base = resolve_base_url()
    knobs = await read_knobs()
    if not base or not knobs["enabled"]:
        raise OcrUnavailable("OCR 서버가 설정되지 않았습니다.")

    # GPU 앞 줄서기 (D177). 자리를 못 잡으면 **기다리지 않고** 붐빈다고 알린다.
    gate = _acquire_gate(knobs["max_concurrent"])
    try:
        await asyncio.wait_for(gate.acquire(), timeout=float(knobs["queue_timeout"]))
    except TimeoutError as exc:
        logger.info("ocr 대기 포기 — 앞이 붐빔")
        raise OcrBusy("지금 인식 요청이 몰려 있습니다.") from exc

    timeout = httpx.Timeout(float(knobs["timeout"]), connect=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(
                f"{base}/ocr",
                files={"file": (filename, image, content_type)},
                data={"max_new_tokens": str(knobs["max_new_tokens"])},
            )
    except httpx.HTTPError as exc:  # 연결 실패·타임아웃
        logger.warning("ocr 요청 실패: %s", exc)
        raise OcrUpstreamError(str(exc)) from exc
    finally:
        gate.release()

    if res.status_code >= 400:
        # 모델 서버의 400(이미지 디코딩 실패)까지 502로 뭉개지 않는다 — 무엇이
        # 잘못됐는지는 상태 코드에 이미 들어 있다.
        logger.warning("ocr 응답 %s: %s", res.status_code, res.text[:300])
        raise OcrUpstreamError(f"HTTP {res.status_code}")

    try:
        body = res.json()
    except ValueError as exc:
        raise OcrUpstreamError("응답을 해석할 수 없습니다.") from exc

    text = body.get("text")
    if not isinstance(text, str):
        # 계약이 바뀌었거나 다른 서비스를 가리키고 있다. 조용히 빈 값을 주면
        # 화면에는 "알아보지 못했어요"로만 보여 원인을 못 찾는다.
        raise OcrUpstreamError("응답에 text가 없습니다.")

    return merge_layout(text, body.get("boxes"))
