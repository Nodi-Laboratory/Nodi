"""File endpoints (Stage 3b-1) — upload + list + status.

Upload requires the service-role client (storage write + the embedding pipeline
need it). If SUPABASE_SERVICE_ROLE_KEY is unset, upload returns 503; list/get
still work (RLS reads via the caller's JWT).
"""

from __future__ import annotations

from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from pydantic import BaseModel

from ..auth.deps import CurrentUser, get_current_user
from ..config import get_settings
from ..services import files as svc
from ..services.service_client import get_service_client
from ..services.supabase_client import UserClient

router = APIRouter(prefix="/files", tags=["files"])
settings = get_settings()


class LinkBody(BaseModel):
    target_node_id: str


class FilePositionBody(BaseModel):
    position_x: float | None = None
    position_y: float | None = None


@router.post("", status_code=201)
async def upload(
    file: UploadFile = File(...),
    space_kind: str = Form("personal"),
    space_ref: str | None = Form(None),
    session_id: str | None = Form(None),
    position_x: float | None = Form(None),
    position_y: float | None = Form(None),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Upload a file -> Storage + files row + queued embedding_split job.

    Optional `session_id` + `position_x/y` place the file as a node in a session
    graph (D13).
    """
    service = get_service_client()
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="File uploads are disabled (service-role key not configured).",
        )
    # Early reject on declared size (avoid buffering an oversized body).
    if file.size is not None and file.size > settings.file_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {settings.file_max_bytes} bytes.",
        )
    data = await file.read()
    return await svc.upload_file(
        service,
        UserClient.from_user(user),
        owner_id=user.id,
        space_kind=space_kind,
        space_ref=space_ref,
        filename=file.filename or "upload",
        mime=file.content_type,
        data=data,
        session_id=session_id,
        position_x=position_x,
        position_y=position_y,
    )


@router.get("")
async def list_files(
    space_kind: str = Query(..., pattern="^(personal|class)$"),
    space_ref: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    ref = space_ref or (user.id if space_kind == "personal" else None)
    if not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class space requires space_ref (class id).",
        )
    client = UserClient.from_user(user)
    return await svc.list_files(client, space_kind, ref)


@router.get("/{file_id}")
async def get_file(
    file_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """File row incl. status + progress (chunk_done / chunk_total)."""
    client = UserClient.from_user(user)
    return await svc.get_file(client, file_id)


@router.patch("/{file_id}/position")
async def set_file_position(
    file_id: str,
    body: FilePositionBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist a file-node's coordinates after drag (D13). Owner only."""
    client = UserClient.from_user(user)
    return await svc.set_file_position(
        client, file_id, body.position_x, body.position_y
    )


# --- Visual RAG links (Stage 3b-2) ---------------------------------------
@router.post("/{file_id}/links", status_code=201)
async def add_link(
    file_id: str,
    body: LinkBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Link this file to a node ("use this file when answering from this branch").

    Applies to the node and its descendant branch. Caller must own both the file
    and the node's session. Idempotent.
    """
    client = UserClient.from_user(user)
    return await svc.add_link(client, user.id, file_id, body.target_node_id)


@router.delete("/{file_id}/links/{node_id}", status_code=204)
async def remove_link(
    file_id: str,
    node_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> None:
    client = UserClient.from_user(user)
    await svc.remove_link(client, file_id, node_id)
