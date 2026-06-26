"""File upload + registration (Stage 3b-1).

Upload writes to Storage and inserts the `files` row + an `embedding_split` job
via the service-role client (the worker pipeline needs service_role anyway).
owner_id is set explicitly to the caller, preserving isolation. List/get are
request-time reads and use the caller's RLS-scoped UserClient.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException, status

from ..config import get_settings
from .service_client import ServiceClient
from .supabase_client import UserClient

settings = get_settings()

FILE_SELECT = (
    "id,owner_id,space_kind,space_ref,uploader_id,kind,storage_path,mime,"
    "size_bytes,status,chunk_total,chunk_done,error,created_at,updated_at"
)


async def upload_file(
    service: ServiceClient,
    owner_id: str,
    space_kind: str,
    space_ref: str | None,
    filename: str,
    mime: str | None,
    data: bytes,
) -> dict[str, Any]:
    if space_kind not in ("personal", "class"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="space_kind must be 'personal' or 'class'.",
        )
    ref = space_ref or (owner_id if space_kind == "personal" else None)
    if space_kind == "class" and not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class files require space_ref (class id).",
        )
    if not data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Empty file.",
        )
    if len(data) > settings.file_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {settings.file_max_bytes} bytes.",
        )

    file_id = str(uuid.uuid4())
    safe_name = (filename or "upload").replace("/", "_").replace("\\", "_")
    storage_path = f"{owner_id}/{file_id}/{safe_name}"

    await service.storage_upload(
        settings.storage_bucket, storage_path, data, mime or "application/octet-stream"
    )

    rows = await service.insert(
        "files",
        {
            "id": file_id,
            "owner_id": owner_id,
            "space_kind": space_kind,
            "space_ref": ref,
            "uploader_id": owner_id,
            "kind": "user_upload",
            "storage_path": storage_path,
            "mime": mime,
            "size_bytes": len(data),
            "status": "uploaded",
        },
    )
    file_row = rows[0]

    # Enqueue the split job (worker picks it up).
    await service.insert(
        "jobs",
        {
            "owner_id": owner_id,
            "kind": "embedding_split",
            "target_id": file_id,
            "status": "queued",
            "space_ref": ref,
        },
        returning=False,
    )
    return file_row


async def list_files(
    client: UserClient, space_kind: str, space_ref: str
) -> list[dict[str, Any]]:
    return await client.select(
        "files",
        {
            "space_kind": f"eq.{space_kind}",
            "space_ref": f"eq.{space_ref}",
            "select": FILE_SELECT,
            "order": "created_at.desc",
        },
    )


async def get_file(client: UserClient, file_id: str) -> dict[str, Any]:
    rows = await client.select(
        "files",
        {"id": f"eq.{file_id}", "select": FILE_SELECT, "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found.",
        )
    return rows[0]
