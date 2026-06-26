"""Session endpoints — list / create / fetch-with-nodes (tree restore)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from ..auth.deps import CurrentUser, get_current_user
from ..services import sessions as svc
from ..services.supabase_client import UserClient

router = APIRouter(prefix="/sessions", tags=["sessions"])


class CreateSessionBody(BaseModel):
    space_kind: str  # 'personal' | 'class'
    space_ref: str | None = None  # class id for class; defaults to owner for personal
    title: str | None = None


@router.post("", status_code=201)
async def create_session(
    body: CreateSessionBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    client = UserClient.from_user(user)
    return await svc.create_session(
        client, user.id, body.space_kind, body.space_ref, body.title
    )


@router.get("")
async def list_sessions(
    space_kind: str = Query(..., pattern="^(personal|class)$"),
    space_ref: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await svc.list_sessions(client, space_kind, space_ref, user.id)


@router.get("/{session_id}")
async def get_session(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Session metadata + all of its nodes, for client-side tree reconstruction."""
    client = UserClient.from_user(user)
    session = await svc.get_session(client, session_id)
    nodes = await svc.get_session_nodes(client, session_id)
    return {"session": session, "nodes": nodes}
