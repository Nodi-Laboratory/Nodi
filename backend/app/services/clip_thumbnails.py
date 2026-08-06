"""강의 클립 썸네일 (D190) — 관리자가 올린 그림 창고.

## 왜 우리가 그림을 들고 있나

클립 카드에 그림이 없으면 "영상"으로 안 읽힌다. 그런데 **EBS 썸네일을 가져올
방법이 없다** — 남의 사이트 이미지를 긁는 것은 저작권·차단 양쪽에서 문제고,
링크로 걸면 저쪽이 바꾸는 순간 깨진 그림이 남는다.

그래서 관리자가 쓸 만한 그림 몇 장을 올려 두고 클립마다 그중 하나를 보여
준다(사용자 결정 2026-08-06). 실제 그 강의의 장면은 아니지만 **카드가 무엇인지는
말해 준다.**

## 어느 그림을 보여 줄지는 화면이 정한다

여기서 고르지 않는다. 서버가 매번 무작위로 하나를 주면 **같은 클립이 볼 때마다
다른 그림**이 되어 학생이 어제 본 카드를 못 알아본다. 화면이 clip id로 골라
쓰면 그 카드는 언제나 같은 그림이다(`lib/canvas2/clipThumb.ts`).
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import HTTPException, status

from ..config import get_settings
from ..db.client import UserClient, get_service_client

logger = logging.getLogger("nodi.clip_thumbnails")
settings = get_settings()

SELECT = "id,name,mime,size_bytes,created_at"

# 그림 한 장 상한. 썸네일이라 이보다 커야 할 이유가 없고, 큰 파일은 학생
# 화면에서 그대로 내려받게 된다.
MAX_BYTES = 4 * 1024 * 1024

ALLOWED_MIME = ("image/png", "image/jpeg", "image/webp", "image/gif")

# 화면이 받아 가는 목록의 상한. 이보다 많이 올려도 고르는 데 쓰는 것은 이만큼
# 이다 — 목록은 캔버스가 열릴 때마다 오므로 짧아야 한다.
LIST_CAP = 60


async def list_thumbnails(client: UserClient) -> list[dict[str, Any]]:
    """썸네일 목록(최신순). 로그인한 누구나 읽는다 — 장식용 그림이다."""
    return await client.select(
        "clip_thumbnails",
        {"select": SELECT, "order": "created_at.desc", "limit": str(LIST_CAP)},
    )


async def add_thumbnail(
    client: UserClient,
    *,
    owner_id: str,
    filename: str,
    mime: str | None,
    data: bytes,
) -> dict[str, Any]:
    """그림 한 장 등록. 관리자 전용(RLS가 강제한다)."""
    if not data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="빈 파일입니다."
        )
    if len(data) > MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"그림이 너무 큽니다({len(data) / 1024 / 1024:.1f}MB). "
                f"{MAX_BYTES // 1024 // 1024}MB까지 올릴 수 있습니다."
            ),
        )
    kind = (mime or "").split(";")[0].strip().lower()
    if kind not in ALLOWED_MIME:
        # 형식을 안 보고 받으면 학생 화면의 <img>에 아무거나 들어간다.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="이미지 파일만 올릴 수 있습니다(PNG·JPG·WEBP·GIF).",
        )
    svc = get_service_client()
    if svc is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="파일 저장소가 아직 활성화되지 않았습니다(관리자 설정 필요).",
        )

    thumb_id = str(uuid.uuid4())
    ext = kind.split("/")[-1].replace("jpeg", "jpg")
    path = f"clip-thumbs/{thumb_id}.{ext}"
    await svc.storage_upload(settings.storage_bucket, path, data, kind)
    row = await client.insert(
        "clip_thumbnails",
        {
            "id": thumb_id,
            "storage_path": path,
            "mime": kind,
            "size_bytes": len(data),
            "name": (filename or "썸네일").strip()[:200],
            "created_by": owner_id,
        },
    )
    logger.info("클립 썸네일 등록 %s (%dKB)", thumb_id, len(data) // 1024)
    return row


async def read_bytes(client: UserClient, thumb_id: str) -> tuple[bytes, str]:
    """그림 바이트 + mime. 없으면 404.

    RLS가 먼저 판정하도록 **행을 사용자 권한으로** 읽고, 바이트만 서비스
    권한으로 가져온다(도판 경로와 같은 계약).
    """
    rows = await client.select(
        "clip_thumbnails",
        {"select": "id,storage_path,mime", "id": f"eq.{thumb_id}", "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="썸네일을 찾을 수 없습니다."
        )
    svc = get_service_client()
    if svc is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="파일 저장소가 아직 활성화되지 않았습니다.",
        )
    data = await svc.storage_download(settings.storage_bucket, rows[0]["storage_path"])
    return data, str(rows[0].get("mime") or "image/png")


async def remove_thumbnail(client: UserClient, thumb_id: str) -> None:
    """행을 지우고 바이트도 지운다. 관리자 전용."""
    rows = await client.select(
        "clip_thumbnails",
        {"select": "id,storage_path", "id": f"eq.{thumb_id}", "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="썸네일을 찾을 수 없습니다."
        )
    await client.delete("clip_thumbnails", {"id": f"eq.{thumb_id}"})
    svc = get_service_client()
    if svc is None:
        return
    try:
        await svc.storage_delete(settings.storage_bucket, rows[0]["storage_path"])
    except Exception:  # noqa: BLE001 - 행이 없어진 뒤라 목록에서는 이미 사라졌다
        logger.warning("썸네일 바이트 삭제 실패 %s", thumb_id, exc_info=True)
