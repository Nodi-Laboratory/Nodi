"""Session + node persistence and ancestor-chain context assembly.

Conversation model (architecture.md §3, §4):
  - 1 node = one (question, answer) pair.
  - Context for a turn = the ancestor chain ONLY (root -> ... -> parent),
    siblings excluded. node.connections (LCA memory-link) is Stage 3, ignored.
All writes go through the caller's RLS-scoped UserClient (owner-only).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status

from .supabase_client import UserClient

# Columns returned to the client for tree reconstruction.
NODE_SELECT = (
    "id,session_id,parent_id,question,answer,label,is_navigator,"
    "navigator_question,position_x,position_y,created_at"
)
SESSION_SELECT = (
    "id,owner_id,space_kind,space_ref,title,emoji,root_node_id,"
    "current_head_id,created_at,updated_at"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ----------------------------------------------------------------------------
# Sessions
# ----------------------------------------------------------------------------
async def create_session(
    client: UserClient,
    owner_id: str,
    space_kind: str,
    space_ref: str | None,
    title: str | None,
) -> dict[str, Any]:
    if space_kind not in ("personal", "class"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="space_kind must be 'personal' or 'class'.",
        )
    # personal space_ref defaults to the owner's own id (per data model).
    ref = space_ref or (owner_id if space_kind == "personal" else None)
    if space_kind == "class" and not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class sessions require space_ref (class id).",
        )
    row = {
        "owner_id": owner_id,
        "space_kind": space_kind,
        "space_ref": ref,
        "title": title,
    }
    return await client.insert("sessions", row)


async def list_sessions(
    client: UserClient,
    space_kind: str,
    space_ref: str | None,
    owner_id: str,
) -> list[dict[str, Any]]:
    # personal space_ref defaults to the owner's own id (mirrors create_session).
    ref = space_ref or (owner_id if space_kind == "personal" else None)
    if space_kind == "class" and not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class sessions require space_ref (class id).",
        )
    return await client.select(
        "sessions",
        {
            "space_kind": f"eq.{space_kind}",
            "space_ref": f"eq.{ref}",
            "select": SESSION_SELECT,
            "order": "updated_at.desc",
        },
    )


async def get_session(client: UserClient, session_id: str) -> dict[str, Any]:
    rows = await client.select(
        "sessions",
        {"id": f"eq.{session_id}", "select": SESSION_SELECT, "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or not accessible.",
        )
    return rows[0]


async def get_session_nodes(
    client: UserClient, session_id: str
) -> list[dict[str, Any]]:
    return await client.select(
        "nodes",
        {
            "session_id": f"eq.{session_id}",
            "select": NODE_SELECT,
            "order": "created_at.asc",
        },
    )


# ----------------------------------------------------------------------------
# Nodes + context
# ----------------------------------------------------------------------------
def assemble_history(
    nodes: list[dict[str, Any]], parent_node_id: str | None
) -> list[tuple[str, str]]:
    """Ancestor chain (root -> ... -> parent) as ordered (question, answer)."""
    if not parent_node_id:
        return []
    by_id = {n["id"]: n for n in nodes}
    chain: list[dict[str, Any]] = []
    cursor = by_id.get(parent_node_id)
    guard = 0
    while cursor is not None and guard < 10000:
        chain.append(cursor)
        cursor = by_id.get(cursor.get("parent_id"))
        guard += 1
    chain.reverse()  # root first
    return [(n.get("question") or "", n.get("answer") or "") for n in chain]


async def create_node(
    client: UserClient,
    session_id: str,
    parent_id: str | None,
    question: str,
    answer: str,
) -> dict[str, Any]:
    row = {
        "session_id": session_id,
        "parent_id": parent_id,
        "question": question,
        "answer": answer,
    }
    return await client.insert("nodes", row)


async def set_node_label(
    client: UserClient, node_id: str, label: str
) -> None:
    await client.update("nodes", {"id": f"eq.{node_id}"}, {"label": label})


async def advance_head(
    client: UserClient,
    session_id: str,
    new_node_id: str,
    set_root: bool,
) -> None:
    """Point current_head_id at the new node (and root if this is the first)."""
    patch: dict[str, Any] = {
        "current_head_id": new_node_id,
        "updated_at": _now_iso(),
    }
    if set_root:
        patch["root_node_id"] = new_node_id
    await client.update("sessions", {"id": f"eq.{session_id}"}, patch)
