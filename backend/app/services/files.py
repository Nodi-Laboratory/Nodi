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


async def _assert_class_member(
    user_client: UserClient, owner_id: str, class_id: str
) -> None:
    """Verify the caller belongs to the class (RLS lets them read own row)."""
    rows = await user_client.select(
        "class_members",
        {
            "class_id": f"eq.{class_id}",
            "user_id": f"eq.{owner_id}",
            "select": "class_id",
            "limit": "1",
        },
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this class.",
        )


async def upload_file(
    service: ServiceClient,
    user_client: UserClient,
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
    # Defense: only upload into a class the caller actually belongs to.
    if space_kind == "class":
        await _assert_class_member(user_client, owner_id, ref)
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


# ---------------------------------------------------------------------------
# Visual RAG links (Stage 3b-2)
# ---------------------------------------------------------------------------
LINK_SELECT = "id,file_id,target_node_id,owner_id,created_at"


async def _owned_node_session(
    client: UserClient, owner_id: str, node_id: str
) -> dict[str, Any]:
    """Return the node's session row, ensuring the caller owns that session."""
    rows = await client.select(
        "nodes",
        {"id": f"eq.{node_id}", "select": "id,session_id", "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Node not found."
        )
    session_id = rows[0]["session_id"]
    srows = await client.select(
        "sessions",
        {
            "id": f"eq.{session_id}",
            "select": "id,owner_id,space_kind,space_ref",
            "limit": "1",
        },
    )
    if not srows or srows[0].get("owner_id") != owner_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not own this node's session.",
        )
    return srows[0]


async def add_link(
    client: UserClient, owner_id: str, file_id: str, target_node_id: str
) -> dict[str, Any]:
    # Both the file and the node's session must be the caller's.
    file_row = await get_file(client, file_id)  # 404 unless owner (RLS)
    session = await _owned_node_session(client, owner_id, target_node_id)
    # Space isolation: a file may only be linked within its own space.
    if (file_row.get("space_kind") != session.get("space_kind")) or (
        file_row.get("space_ref") != session.get("space_ref")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="File and node must belong to the same space.",
        )
    # Idempotent: return the existing link if already present.
    existing = await client.select(
        "file_node_links",
        {
            "file_id": f"eq.{file_id}",
            "target_node_id": f"eq.{target_node_id}",
            "select": LINK_SELECT,
            "limit": "1",
        },
    )
    if existing:
        return existing[0]
    return await client.insert(
        "file_node_links",
        {
            "file_id": file_id,
            "target_node_id": target_node_id,
            "owner_id": owner_id,
        },
    )


async def remove_link(
    client: UserClient, file_id: str, target_node_id: str
) -> None:
    await client.delete(
        "file_node_links",
        {
            "file_id": f"eq.{file_id}",
            "target_node_id": f"eq.{target_node_id}",
        },
    )


async def list_session_file_links(
    client: UserClient, session_id: str
) -> list[dict[str, Any]]:
    """Links for any node in the session, with the linked file embedded."""
    node_rows = await client.select(
        "nodes", {"session_id": f"eq.{session_id}", "select": "id"}
    )
    node_ids = [n["id"] for n in node_rows]
    if not node_ids:
        return []
    return await client.select(
        "file_node_links",
        {
            "target_node_id": f"in.({','.join(node_ids)})",
            "select": (
                "id,file_id,target_node_id,created_at,"
                "files(id,storage_path,mime,status,chunk_total,chunk_done)"
            ),
            "order": "created_at.desc",
        },
    )
