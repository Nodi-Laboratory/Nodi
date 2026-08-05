"""손글씨와 펜 표시를 함께 읽는 창구 (D178).

    POST /api/ink/interpret   multipart:
        ink_png    (필수) 획만 그린 흰 종이 PNG — OCR로 간다
        scene_png  (선택) 카드까지 그린 도식 PNG — 비전 모델로 간다
        figure_png (선택) 도판 확대본
        figure_n   (선택) 그 도판이 몇 번 카드인가
        cards      (선택) [{"n":1,"title":"천문학"}, …] JSON
        lang       (선택) 기본 "ko"
    200 → {"text": …, "marks_note": …, "pointed": 2|null, "confidence": null}

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
from ..services import ink_marks
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
        out.append({"n": n, "title": clean})
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
    # 계약에 있어 받지만 VARCO는 언어 인자가 없다(ocr.py와 같은 이유).
    lang: str = Form("ko"),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """손글씨를 읽고, 표시가 무엇을 가리키는지 함께 읽는다.

    **로그인을 요구한다.** 모델 서버들은 인증이 없어 이 창구가 GPU 앞의 문이다.
    """
    if not svc.is_configured():
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

    async def _ocr() -> str:
        return await svc.recognize(
            ink_bytes,
            filename=ink_png.filename or "handwriting.png",
            content_type=ink_png.content_type or "image/png",
        )

    async def _marks() -> tuple[int | None, str]:
        # 도식이 없으면 볼 것이 없다. 카드가 하나도 없어도 마찬가지 —
        # "무엇을 가리키나"에 후보가 없다.
        if not scene_bytes or not roster:
            return None, ""
        return await ink_marks.read_marks(
            roster,
            scene_bytes,
            figure_bytes or None,
            figure_n if settings.ink_figure_zoom_enabled else None,
        )

    # **동시에 돈다.** OCR은 GPU 1(VARCO), 비전은 GPU 0(llama.cpp)이라
    # 실제로 병렬이다 — 순서대로 부르면 대기가 그대로 더해진다.
    text_res, marks_res = await asyncio.gather(
        _ocr(), _marks(), return_exceptions=True
    )

    # 표시 해석 실패는 여기서 끝난다. read_marks가 이미 삼키지만, 그 밖의
    # 예외(취소 등)도 질문을 막아서는 안 된다.
    pointed: int | None = None
    marks_note = ""
    if isinstance(marks_res, BaseException):
        logger.warning("표시 해석 실패 — 표시 없이 진행", exc_info=marks_res)
    else:
        pointed, marks_note = marks_res

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
        "pointed": pointed,
        "confidence": None,
    }
