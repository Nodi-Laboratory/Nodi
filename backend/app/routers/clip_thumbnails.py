"""강의 클립 썸네일 읽기 창구 (D190).

## 왜 별도 라우터인가

처음에는 `/files/clip-thumbnails`로 뒀다가 **`/files/{file_id}`가 삼켰다** —
FastAPI는 선언 순서로 맞추는데 그 경로가 먼저라, `clip-thumbnails`가 파일
id(uuid)로 파싱되어 502가 났다(실측 2026-08-06). 정적 경로를 먼저 선언하면
지금은 고쳐지지만, **다음 사람이 순서를 바꾸면 조용히 다시 깨진다.**

겹칠 수 없는 자리에 두면 그 걱정이 성립하지 않는다.

넣고 빼는 쪽은 `/admin/clip-thumbnails`다(관리자 전용).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Response

from ..auth.deps import CurrentUser, get_current_user
from ..db.client import UserClient
from ..services import clip_thumbnails

router = APIRouter(prefix="/clip-thumbnails", tags=["clip-thumbnails"])


@router.get("")
async def list_clip_thumbnails(
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """고를 수 있는 썸네일 목록. 로그인한 누구나 — 장식용 그림이다."""
    return await clip_thumbnails.list_thumbnails(UserClient.from_user(user))


@router.get("/{thumb_id}/raw")
async def get_clip_thumbnail_raw(
    thumb_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """썸네일 바이트.

    `<img src>`는 Authorization을 못 싣는다 — 같은 출처(`/api`)라 되는 배포와
    달리 **로컬에서만 깨진다**. 도판이 겪은 그 함정이라(D178) 처음부터 인증
    창구로 두고, 화면은 `fetch` + object URL로 그린다.

    캐시를 길게 준다: 관리자가 지우기 전까지 안 바뀌는 그림이고, 클립 카드가
    뜰 때마다 다시 받으면 낭비다.
    """
    data, mime = await clip_thumbnails.read_bytes(UserClient.from_user(user), thumb_id)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "private, max-age=86400"},
    )
