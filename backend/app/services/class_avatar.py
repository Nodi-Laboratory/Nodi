"""학급 프로필 사진 (사용자 지시 2026-08-09).

세션 선택 화면에서 학급을 **그림으로** 알아보게 한다. 이름 첫 글자 하나로는
"3학년 1반"과 "3학년 2반"이 구분되지 않는다.

## 누가 정하나

**그 학급의 선생님만.** 학생이 바꿀 수 있으면 반 전체가 보는 그림이 한 사람
장난에 달린다. 판정은 `classes.teacher_id`로 하고, 읽기는 그 반 사람 누구나
할 수 있게 둔다(RLS가 이미 그 경계를 안다).

## 주소를 저장하지 않는다

Storage 경로만 `classes.avatar_path`에 남기고, 화면은 우리 창구로 받아 간다.
서명 URL을 DB에 넣으면 만료된 순간 깨진 그림이 남는다 — D87이 도판에서 같은
결론을 내렸다.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import HTTPException, status

from ..config import get_settings
from ..db.client import UserClient, get_service_client

logger = logging.getLogger("nodi.class_avatar")
settings = get_settings()

#: 사진 한 장 상한. 프로필 사진이라 이보다 커야 할 이유가 없고, 큰 파일은
#: 세션 선택 화면이 열릴 때마다 학생 기기로 그대로 내려간다.
MAX_BYTES = 4 * 1024 * 1024

ALLOWED_MIME = ("image/png", "image/jpeg", "image/webp")


async def _class_row(client: UserClient, class_id: str) -> dict[str, Any]:
    rows = await client.select(
        "classes", {"id": f"eq.{class_id}", "select": "id,name,teacher_id,avatar_path"}
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="학급을 찾을 수 없습니다."
        )
    return rows[0]


async def set_avatar(
    client: UserClient,
    *,
    class_id: str,
    user_id: str,
    filename: str,
    mime: str | None,
    data: bytes,
) -> dict[str, Any]:
    """사진을 올린다. **그 학급의 담임만.**"""
    row = await _class_row(client, class_id)
    if str(row.get("teacher_id") or "") != str(user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="이 학급의 선생님만 사진을 바꿀 수 있습니다.",
        )
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="빈 파일입니다.")
    if len(data) > MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"사진은 {MAX_BYTES // (1024 * 1024)}MB까지 올릴 수 있어요.",
        )
    kind = (mime or "").split(";")[0].strip().lower()
    if kind not in ALLOWED_MIME:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="PNG·JPEG·WebP 그림만 올릴 수 있어요.",
        )

    svc = get_service_client()
    if svc is None:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="파일 저장소가 준비되지 않았습니다."
        )
    ext = (filename or "img").rsplit(".", 1)[-1].lower()
    if ext not in ("png", "jpg", "jpeg", "webp"):
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[kind]
    # 이름에 uuid를 넣어 **덮어쓰지 않는다** — 같은 경로에 다시 올리면 학생
    # 브라우저가 옛 그림을 캐시에서 계속 준다.
    path = f"class-avatars/{class_id}/{uuid.uuid4().hex}.{ext}"
    await svc.storage_upload(settings.storage_bucket, path, data, kind)
    await client.update("classes", {"id": f"eq.{class_id}"}, {"avatar_path": path})
    return {"class_id": class_id, "has_avatar": True}


async def read_bytes(client: UserClient, class_id: str) -> tuple[bytes, str]:
    """사진 바이트와 MIME. **읽기는 그 반 사람 누구나** (RLS가 판정한다)."""
    row = await _class_row(client, class_id)
    path = row.get("avatar_path")
    if not path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="사진이 없습니다.")
    svc = get_service_client()
    if svc is None:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="파일 저장소가 준비되지 않았습니다."
        )
    data = await svc.storage_download(settings.storage_bucket, str(path))
    ext = str(path).rsplit(".", 1)[-1].lower()
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
    return data, mime.get(ext, "application/octet-stream")
