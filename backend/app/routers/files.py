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

from ..auth.deps import CurrentUser, get_current_user
from ..services import files as svc
from ..services.service_client import get_service_client
from ..services.supabase_client import UserClient

router = APIRouter(prefix="/files", tags=["files"])


@router.post("", status_code=201)
async def upload(
    file: UploadFile = File(...),
    space_kind: str = Form("personal"),
    space_ref: str | None = Form(None),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Upload a file -> Storage + files row + queued embedding_split job."""
    service = get_service_client()
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="File uploads are disabled (service-role key not configured).",
        )
    data = await file.read()
    return await svc.upload_file(
        service,
        owner_id=user.id,
        space_kind=space_kind,
        space_ref=space_ref,
        filename=file.filename or "upload",
        mime=file.content_type,
        data=data,
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
