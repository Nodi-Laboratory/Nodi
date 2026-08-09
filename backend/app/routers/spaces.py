"""세션 선택 화면이 쓰는 창구 (사용자 지시 2026-08-09).

  GET  /api/spaces/overview              내 공간들 + 자료·강의 수 + 개념
  GET  /api/spaces/rooms                 한 공간의 대화방 + 방마다의 개념
  GET  /api/spaces/recent                공간 상관없이 최근 대화방
  GET  /api/spaces/classes/{id}/avatar   학급 프로필 사진 (그 반 사람 누구나)
  PUT  /api/spaces/classes/{id}/avatar   사진 올리기 (그 학급 선생님만)

⚠️ 사진 경로를 `/files/...` 아래 두지 않는다. 거기에는 이미 `/files/{file_id}`가
있어서 **먼저 선언된 그 경로가 삼킨다**(D190이 클립 썸네일에서 겪은 그 사고).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import Response

from ..auth.deps import CurrentUser, get_current_user
from ..db.client import UserClient
from ..services import class_avatar, space_rooms, spaces_overview

router = APIRouter(prefix="/spaces", tags=["spaces"])


@router.get("/overview")
async def overview(
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    return await spaces_overview.overview(UserClient.from_user(user), user.id)


@router.get("/rooms")
async def rooms(
    space_kind: str = Query(..., pattern="^(personal|class)$"),
    space_ref: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    return await space_rooms.rooms(
        UserClient.from_user(user), str(user.id), space_kind, space_ref
    )


@router.get("/recent")
async def recent(
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    return await space_rooms.recent(UserClient.from_user(user), str(user.id))


@router.get("/classes/{class_id}/avatar")
async def get_class_avatar(
    class_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    data, mime = await class_avatar.read_bytes(UserClient.from_user(user), class_id)
    # 경로에 uuid가 들어 있어 내용이 바뀌면 주소도 바뀐다 — 길게 캐시해도
    # 옛 그림이 남지 않는다.
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.put("/classes/{class_id}/avatar")
async def put_class_avatar(
    class_id: str,
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    data = await file.read()
    return await class_avatar.set_avatar(
        UserClient.from_user(user),
        class_id=class_id,
        user_id=str(user.id),
        filename=file.filename or "avatar",
        mime=file.content_type,
        data=data,
    )
