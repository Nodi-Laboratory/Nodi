"""손글씨 폰트 서빙 — **인증 없이** (D210 8-1).

폰트는 로그인 전 화면에서도 쓰일 수 있고, `@font-face`의 `src:`는 헤더를 못
싣는다. 담긴 것은 글자 모양뿐이라 공개해도 잃을 것이 없다.

⚠️ 경로에 사용자 입력(slug)이 들어간다. 서비스가 **행을 거쳐서만** 파일을
찾는다 — 요청 문자열로 직접 경로를 만들지 않는다(`..`로 저장소를 걸어 다니는
길을 열지 않는다).

`/health/config`를 공개로 열지 않는 것과 같은 잣대다: 공개하는 것은 **글자
모양**이지 설정이 아니다.
"""

from __future__ import annotations

from fastapi import APIRouter, Response

from ..db.client import get_service_client
from ..services import hand_fonts

router = APIRouter(prefix="/hand-fonts", tags=["hand-fonts"])


@router.get("/{slug}/{variant}")
async def get_font(slug: str, variant: str) -> Response:
    """폰트 바이트. `variant`는 `web`(학생 화면) 또는 `full`(관리자 시험).

    읽기 정책이 `USING (true)`라 서비스 클라이언트로 읽어도 권한이 넓어지지
    않는다 — 인증이 없는 경로라 사용자 스코프 클라이언트를 만들 수 없다.
    """
    svc = get_service_client()
    data, mime = await hand_fonts.read_bytes(
        svc, slug, "full" if variant.startswith("full") else "web"
    )
    return Response(
        content=data,
        media_type=mime,
        headers={
            # 폰트는 내용이 바뀌지 않는다(바꾸면 새 slug가 생긴다). 오래 캐시한다 —
            # 캔버스를 열 때마다 다시 받으면 교실 회선에서 그대로 느려진다.
            "Cache-Control": "public, max-age=31536000, immutable",
            # 다른 출처에서도 읽을 수 있게 — 배포는 같은 출처지만 로컬 개발은
            # 프론트(3000)와 백엔드(8000)가 다르다.
            "Access-Control-Allow-Origin": "*",
        },
    )
