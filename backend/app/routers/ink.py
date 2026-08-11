"""손글씨와 펜 표시를 함께 읽는 창구 (D178).

    POST /api/ink/interpret   multipart:
        ink_png    (필수) 획만 그린 흰 종이 PNG — OCR로 간다
        scene_png  (선택) 카드까지 그린 도식 PNG — 비전 모델로 간다
        figure_png (선택) 도판 확대본
        figure_n   (선택) 그 도판이 몇 번 카드인가
        cards      (선택) [{"n":1,"title":"천문학","where":"맨 윗줄 왼쪽","mark":"circled"}, …] JSON
        gestures   (선택) [{"shape":"arrow","points":[3],"from":[1],…}, …] JSON
        lang       (선택) 기본 "ko"
    200 → {"text": …, "marks_note": …, "confidence": null}

**어느 카드를 짚었는지는 여기서 정하지 않는다** — 프론트가 기하로 이미
센다(`inkScene`·`inkShapes`). 창구는 그 사실을 프롬프트에 실어 주고, 모델은
설명 문장만 쓴다.

## 왜 두 모델에 다른 그림을 주나

OCR에 카드가 들어가면 **카드 본문까지 읽어 온다** — 그러면 어디까지가 학생의
질문이고 어디부터가 카드 내용인지 가르는 일이 새로 생기고, 틀리면 학생이 쓰지
않은 문장이 질문이 된다. VLM에 카드가 빠지면 **화살표가 허공을 가리킨다.**

## 왜 기존 /ocr/handwriting을 안 고쳤나

계약과 테스트가 붙어 있어 **살려 둔다**. 다만 화면은 더 이상 그쪽을 부르지
않는다 — 카드가 없는 경우도 이 창구가 처리한다(도식이 안 오면 비전을 아예
안 부르므로 저쪽과 하는 일이 같다). 손으로 확인하거나 옛 클라이언트가 남아
있을 때를 위한 창구다.

## 실패를 서로 다르게 대한다

VLM 실패는 삼킨다(`marks_note=""`). OCR 실패는 올린다 — **다른 둘은 곁들이고
OCR은 질문 자체다.** 손글씨를 못 읽으면 대체할 것이 없다.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from ..auth.deps import CurrentUser, get_current_user
from ..config import get_settings
from ..services import handwriting_vision, ink_marks
from ..services import ocr as svc

logger = logging.getLogger("nodi.ink")
router = APIRouter(prefix="/ink", tags=["ink"])
settings = get_settings()

# 명부 상한 — 프론트가 ink_card_max로 이미 자르지만, 창구는 자기 입력을 믿지 않는다.
_CARDS_MAX = 8
# 제목 한 줄 상한. 명부는 프롬프트에 그대로 들어가므로 길이를 우리가 정한다 —
# 안 자르면 카드 하나가 지시문을 밀어낼 수 있다.
_TITLE_MAX = 120


def _parse_cards(raw: str) -> list[dict]:
    """카드 명부 JSON → 정규화된 목록. **못 읽으면 빈 목록**(질문을 막지 않는다).

    번호는 우리가 다시 매기지 않고 프론트가 준 `n`을 그대로 쓴다 — 그 번호가
    도식 그림에 박힌 배지 숫자이고, 여기서 새로 매기면 그림과 어긋난다.
    """
    if not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning("카드 명부를 읽지 못했다 — 표시 해석을 건너뛴다")
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    seen: set[int] = set()
    for item in data[:_CARDS_MAX]:
        if not isinstance(item, dict):
            continue
        try:
            n = int(item.get("n"))
        except (TypeError, ValueError):
            continue
        # 번호가 겹치면 명부가 "1 = A / 1 = B"가 되어 모델이 무엇을 가리키는지
        # 말할 수 없다. 먼저 온 것을 남긴다.
        if n < 1 or n in seen:
            continue
        seen.add(n)
        title = item.get("title")
        # 줄바꿈을 지운다 — 명부는 한 줄에 하나라 개행이 섞이면 형식이 깨지고,
        # 거기에 지시문 흉내를 넣을 여지가 생긴다.
        clean = " ".join(title.split())[:_TITLE_MAX] if isinstance(title, str) else ""
        where = item.get("where")
        mark = item.get("mark")
        out.append({
            "n": n,
            "title": clean,
            "where": " ".join(where.split())[:40] if isinstance(where, str) else "",
            # 기하가 센 값이다 — 모르는 값은 버린다(프롬프트에 헛말을 넣지 않는다).
            "mark": mark if mark in ink_marks.MARK_WORDS else "",
        })
    return out


#: 표시 상한. 학생이 낙서를 잔뜩 해도 프롬프트가 지시문을 밀어내면 안 된다.
_GESTURES_MAX = 8
#: 표시 하나가 거느릴 수 있는 카드 번호 수.
_REFS_MAX = 8
_GESTURE_KEYS = ("encloses", "within", "points", "from", "crosses")


def _nums(raw: object, valid: set[int]) -> list[int]:
    """번호 목록 정규화. **명부에 없는 번호는 버린다.**

    있지도 않은 `[카드 9]`가 프롬프트에 실리면 모델이 그 번호를 그대로 옮겨
    적고, 그 설명이 SOLAR로 간다 — 아무도 못 잡는 거짓말이 된다.
    """
    if not isinstance(raw, list):
        return []
    out: list[int] = []
    for v in raw[:_REFS_MAX]:
        try:
            n = int(v)
        except (TypeError, ValueError):
            continue
        if n in valid and n not in out:
            out.append(n)
    return out


def _parse_gestures(raw: str, valid: set[int]) -> list[dict]:
    """표시 목록 JSON → 정규화된 목록. **못 읽으면 빈 목록**(질문을 막지 않는다).

    카드 명부와 같은 태도다 — 창구는 자기 입력을 믿지 않는다. 모양 이름도
    아는 것만 통과시킨다(모르는 값은 `gesture_line`이 "표시"로 떨어뜨린다).
    """
    if not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning("표시 목록을 읽지 못했다 — 카드 명부만으로 진행한다")
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for i, item in enumerate(data[:_GESTURES_MAX], start=1):
        if not isinstance(item, dict):
            continue
        shape = item.get("shape")
        row: dict = {
            "i": i,
            "shape": shape if shape in ink_marks.SHAPE_WORDS else "",
        }
        for key in _GESTURE_KEYS:
            row[key] = _nums(item.get(key), valid)
        # 어느 카드와도 관계가 없는 표시는 프롬프트에 실을 것이 없다.
        if any(row[key] for key in _GESTURE_KEYS):
            out.append(row)
    return out


async def _read(upload: UploadFile | None, *, label: str) -> bytes:
    """업로드 바이트. 상한을 넘으면 413."""
    if upload is None:
        return b""
    data = await upload.read()
    if len(data) > settings.ocr_max_image_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"{label} 이미지가 너무 큽니다.",
        )
    return data


@router.post("/interpret")
async def interpret_ink(
    ink_png: UploadFile = File(...),
    scene_png: UploadFile | None = File(None),
    figure_png: UploadFile | None = File(None),
    figure_n: int | None = Form(None),
    cards: str = Form(""),
    gestures: str = Form(""),
    # 계약에 있어 받지만 VARCO는 언어 인자가 없다(ocr.py와 같은 이유).
    lang: str = Form("ko"),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """손글씨를 읽고, 표시가 무엇을 가리키는지 함께 읽는다.

    **로그인을 요구한다.** 모델 서버들은 인증이 없어 이 창구가 GPU 앞의 문이다.
    """
    # 주소만이 아니라 **킬 스위치까지** 본다 (D62 점검 2026-08-06).
    # `is_configured()`는 env만 보므로, 관리자가 꺼도 통과했다.
    if not await svc.is_available():
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="필기 인식이 아직 준비되지 않았습니다.",
        )

    ink_bytes = await _read(ink_png, label="손글씨")
    if not ink_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="이미지가 비어 있습니다.",
        )
    scene_bytes = await _read(scene_png, label="화면")
    figure_bytes = await _read(figure_png, label="도판")
    roster = _parse_cards(cards)
    # 번호는 명부가 정한다 — 표시가 명부에 없는 카드를 가리키면 그건 버린다.
    shots = _parse_gestures(gestures, {c["n"] for c in roster})

    #: 글자를 어느 길로 읽었나. `_ocr`이 채우고 응답에 실어 보낸다.
    #:
    #: ⚠️ **이게 없으면 예비 경로가 조용히 일한다.** VARCO가 내려간 채 비전이
    #: 대신 읽으면 학생 화면은 멀쩡하지만 정확도는 내려가는데, 관리자가 그
    #: 사실을 알 방법이 없었다 — 이 코드베이스가 거듭 잡아 온 "오류 없이
    #: 조용히 나빠지는" 부류다(사용자 지시 2026-08-10).
    text_source = "varco"

    async def _ocr() -> str:
        """손글씨를 읽는다. **전용 OCR을 먼저, 안 되면 비전 모델로** (D181).

        VARCO는 OCR 전용이라 손글씨를 더 정확히 읽는다. 그 GPU 하나가
        내려갔다고 질문 펜 전체가 멈추면 학생은 방금 손으로 쓴 질문을 자판으로
        다시 쳐야 한다 — 실측 2026-08-06: 터널이 끊긴 채였고 아무것도 못 읽었다.
        그런데 같은 화면의 표시 해석은 멀쩡히 돌고 있었다(다른 GPU).

        **순서를 바꾸지 않는다.** 예비 경로가 먼저 돌면 품질이 조용히 내려간다.
        """
        try:
            return await svc.recognize(
                ink_bytes,
                filename=ink_png.filename or "handwriting.png",
                content_type=ink_png.content_type or "image/png",
            )
        except (svc.OcrUnavailable, svc.OcrUpstreamError, svc.OcrBusy):
            nonlocal text_source
            text_source = "unavailable"
            if not handwriting_vision.is_configured():
                raise
            text = await handwriting_vision.recognize(ink_bytes)
            if text:
                text_source = "vision_fallback"
                return text
            # 예비 경로도 못 읽었으면 **원래 실패를 그대로 올린다** — 학생이
            # 보는 문구가 "서버가 안 된다"와 "글씨를 못 읽었다"로 갈려야 한다.
            raise

    async def _marks() -> ink_marks.MarksResult:
        # 도식이 없으면 볼 것이 없다. 카드가 하나도 없어도 마찬가지 —
        # "무엇을 가리키나"에 후보가 없다.
        if not scene_bytes:
            return ink_marks.MarksResult("", "no_scene")
        if not roster:
            return ink_marks.MarksResult("", "no_cards")
        return await ink_marks.read_marks(
            roster,
            scene_bytes,
            figure_bytes or None,
            figure_n if settings.ink_figure_zoom_enabled else None,
            shots,
        )

    # **동시에 돈다.** OCR은 GPU 1(VARCO), 비전은 GPU 0(llama.cpp)이라
    # 실제로 병렬이다 — 순서대로 부르면 대기가 그대로 더해진다.
    text_res, marks_res = await asyncio.gather(
        _ocr(), _marks(), return_exceptions=True
    )

    # 표시 해석 실패는 여기서 끝난다. read_marks가 이미 삼키지만, 그 밖의
    # 예외(취소 등)도 질문을 막아서는 안 된다.
    marks_note = ""
    marks_status = "error"
    if isinstance(marks_res, BaseException):
        logger.warning("표시 해석 실패 — 표시 없이 진행", exc_info=marks_res)
    else:
        marks_note, marks_status = marks_res

    # OCR 실패는 다르다 — 질문 자체를 못 얻은 것이라 대체할 것이 없다.
    # 갈래는 /ocr/handwriting과 **같아야 한다**(프론트가 한 문구 표로 읽는다).
    if isinstance(text_res, BaseException):
        if isinstance(text_res, svc.OcrUnavailable):
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="필기 인식이 아직 준비되지 않았습니다.",
            ) from None
        if isinstance(text_res, svc.OcrBusy):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="지금 인식 요청이 몰려 있어요. 잠시 후 다시 눌러 주세요.",
            ) from None
        if isinstance(text_res, svc.OcrUpstreamError):
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="인식 서버가 응답하지 않습니다.",
            ) from None
        raise text_res

    # 빈 결과는 오류가 아니다 — 못 읽은 것은 학생 잘못이 아니고, 화면이
    # "다시 써 볼까요"로 안내한다(D176 그대로).
    return {
        "text": text_res,
        "marks_note": marks_note,
        # **왜 비었는지**를 함께 준다 — 빈 설명만으로는 꺼짐·미설정·오류를
        # 구분할 수 없고, 그러면 관리자 실험실이 "왜 안 읽혔나"에 답을 못 한다.
        "marks_status": marks_status,
        # 글자를 어느 길로 읽었나 — `varco`(전용) · `vision_fallback`(예비).
        # 예비가 도는 것은 **고장 신호**다: 학생에게는 안 보이지만 정확도가
        # 내려가 있으므로 관리자가 알아야 한다.
        "text_source": text_source,
        "confidence": None,
    }
