"""손글씨 인식 창구 (D176) — 프롬프트창의 펜 입력판이 부른다.

계약은 프론트(`lib/api/ocr.ts`)와 한 쌍이다:

    POST /api/ocr/handwriting   multipart: image(PNG) + lang
    200 → {"text": "...", "confidence": null}

**501은 고장이 아니라 미완성이다** — Gemini 키도 모델 서버 주소도 없거나 꺼져
있을 때 준다(공개판 2026-09-27: Gemini가 1순위, VARCO는 Gemini가 없을 때만).
프론트가 404/501을 한 문구("준비하고 있어요")로 모으므로, 라우터가 아예 없던
시절과 같은 화면이 된다. 502는 다르다: 설정은 됐는데 모델 서버가
안 받는 상태라 "잠시 안 돼요"로 갈린다.

`confidence`는 계약에만 있고 늘 비어 있다. VARCO OCR은 점수를 주지 않는다 —
없는 값을 지어내지 않고 자리만 지킨다(주는 모델로 바꾸면 그때 채운다).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from ..auth.deps import CurrentUser, get_current_user
from ..config import get_settings
from ..services import gemini_vision, handwriting_vision
from ..services import ocr as svc

router = APIRouter(prefix="/ocr", tags=["ocr"])
settings = get_settings()

#: 501 문구 — 공개판(2026-09-27)은 Gemini 키만 있으면 되므로 **무엇을 하면 되는지**
#: 말한다. ink.py도 같은 문구를 쓴다(프론트가 한 문구 표로 읽는다).
UNCONFIGURED_DETAIL = (
    "필기 인식이 아직 준비되지 않았습니다. 앱 설정에서 Gemini API 키를 입력하거나 "
    "서버 .env에 GEMINI_API_KEY를 설정해 주세요."
)
#: Gemini 429 — VARCO 혼잡(OcrBusy)과 같은 갈래(D177: 고장이 아니라 붐빔).
BUSY_DETAIL = "지금 인식 요청이 몰려 있어요. 잠시 후 다시 눌러 주세요."
UPSTREAM_DETAIL = "인식 서버가 응답하지 않습니다."


def gemini_error_to_http(exc: gemini_vision.GeminiError) -> HTTPException:
    """Gemini 실패 → VARCO와 **같은** 상태 코드 갈래(429=503, 나머지=502)."""
    if exc.busy:
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=BUSY_DETAIL)
    return HTTPException(status.HTTP_502_BAD_GATEWAY, detail=UPSTREAM_DETAIL)


@router.post("/handwriting")
async def recognize_handwriting(
    image: UploadFile = File(...),
    # 계약에 있어 받지만 VARCO는 언어 인자가 없다(한국어·영어를 함께 읽는다).
    # 받아 두는 이유: 다국어 모델로 갈아탈 때 프론트를 안 고치기 위해서다.
    lang: str = Form("ko"),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """손글씨 그림 한 장 → 글자.

    **로그인을 요구한다.** OCR 서버 자체는 인증이 없고 CORS가 모두 열려 있어,
    이 창구가 곧 GPU 앞의 문이다.
    """
    # 제공자 우선순위(gemini_vision 머리말): Gemini 키가 있으면 Gemini 단독,
    # 없을 때만 자체 호스팅 VARCO. 둘 다 없으면 501.
    use_gemini = gemini_vision.is_configured()
    if not use_gemini and not svc.is_configured():
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=UNCONFIGURED_DETAIL,
        )

    data = await image.read()
    if not data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="이미지가 비어 있습니다.",
        )
    if len(data) > settings.ocr_max_image_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="이미지가 너무 큽니다.",
        )

    if use_gemini:
        try:
            text = await handwriting_vision.recognize_gemini(data)
        except gemini_vision.GeminiError as exc:
            raise gemini_error_to_http(exc) from None
        return {"text": text, "confidence": None}

    try:
        text = await svc.recognize(
            data,
            filename=image.filename or "handwriting.png",
            content_type=image.content_type or "image/png",
        )
    except svc.OcrUnavailable:
        # 검사와 호출 사이에 설정이 바뀐 드문 경우 — 위와 같은 갈래로 보낸다.
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=UNCONFIGURED_DETAIL,
        ) from None
    except svc.OcrBusy:
        # **502가 아니다** (D177). 모델 서버는 GPU 락으로 요청을 직렬 처리해서
        # 한 반이 동시에 누르면 뒤쪽이 밀린다 — 고장이 아니라 붐비는 것이고,
        # 학생이 할 일도 다르다(다시 누르면 된다).
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=BUSY_DETAIL,
        ) from None
    except svc.OcrUpstreamError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=UPSTREAM_DETAIL,
        ) from None

    # 빈 결과는 오류가 아니다 — 아무것도 못 읽은 것이고, 화면이 "다시 써 볼까요"로
    # 안내한다. 여기서 4xx를 주면 학생 잘못처럼 보인다.
    return {"text": text, "confidence": None}
