"""Session endpoints — list / create / fetch-with-nodes (tree restore)."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..db.client import UserClient
from ..services import sessions as svc

router = APIRouter(prefix="/sessions", tags=["sessions"])


class CreateSessionBody(BaseModel):
    space_kind: str = Field(pattern="^(personal|class)$")
    space_ref: str | None = None  # class id for class; defaults to owner for personal
    title: str | None = Field(default=None, max_length=200)


class RenameSessionBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


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
    #: 이름으로 찾기. 상한(`_LIST_CAP`) 밖의 옛 대화에 닿는 유일한 길이다.
    q: str | None = Query(None, max_length=80),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await svc.list_sessions(client, space_kind, space_ref, user.id, q)


@router.get("/{session_id}")
async def get_session(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Session metadata + all of its nodes, for client-side tree reconstruction."""
    client = UserClient.from_user(user)
    # Session meta and the node list are independent reads -> fetch concurrently
    # (same pattern as chat.py). A 404 from get_session still propagates out of
    # gather as a plain HTTP error.
    session, nodes = await asyncio.gather(
        svc.get_session(client, session_id),
        svc.get_session_nodes(client, session_id),
    )
    return {"session": session, "nodes": nodes}


@router.patch("/{session_id}")
async def rename_session(
    session_id: str,
    body: RenameSessionBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Rename a session (owner only)."""
    client = UserClient.from_user(user)
    return await svc.update_session_title(client, session_id, body.title)


@router.delete("/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Delete a session and its nodes (files are kept; session_id -> null)."""
    client = UserClient.from_user(user)
    await svc.delete_session(client, session_id)


