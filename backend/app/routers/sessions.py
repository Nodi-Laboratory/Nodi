"""Session endpoints — list / create / fetch-with-nodes (tree restore)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..services import files as files_svc
from ..services import rag
from ..services import sessions as svc
from ..services.supabase_client import UserClient

router = APIRouter(prefix="/sessions", tags=["sessions"])


class CreateSessionBody(BaseModel):
    space_kind: str = Field(pattern="^(personal|class)$")
    space_ref: str | None = None  # class id for class; defaults to owner for personal
    title: str | None = Field(default=None, max_length=200)


class RenameSessionBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class NodePosition(BaseModel):
    node_id: str
    x: float | None = None
    y: float | None = None


class NodePositionsBody(BaseModel):
    positions: list[NodePosition] = Field(default_factory=list, max_length=2000)


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
    nodes = await svc.get_session_nodes(client, session_id, with_tags=True)
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


@router.put("/{session_id}/node-positions")
async def set_node_positions(
    session_id: str,
    body: NodePositionsBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Batch-persist node coordinates after drag/relayout (D20)."""
    client = UserClient.from_user(user)
    n = await svc.set_node_positions(
        client, session_id, [p.model_dump() for p in body.positions]
    )
    return {"updated": n}


@router.get("/{session_id}/file-links")
async def get_session_file_links(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Files linked to any node in this session (for graph file-nodes + edges)."""
    client = UserClient.from_user(user)
    await svc.get_session(client, session_id)  # 404/RLS gate
    return await files_svc.list_session_file_links(client, session_id)


@router.get("/{session_id}/file-suggestions")
async def get_file_suggestions(
    session_id: str,
    node_id: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """When the current branch has no linked files, propose space files to link
    (embedding match). Empty if files are already linked or none indexed."""
    client = UserClient.from_user(user)
    session = await svc.get_session(client, session_id)
    head = node_id or session.get("current_head_id")
    nodes = await svc.get_session_nodes(client, session_id)
    chain = svc.ancestor_chain_nodes(nodes, head)
    suggestions = await rag.suggest_files(
        client, chain, session.get("space_kind"), session.get("space_ref")
    )
    return {"suggestions": suggestions}
