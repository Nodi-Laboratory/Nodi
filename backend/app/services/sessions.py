"""Session + node persistence and ancestor-chain context assembly.

Conversation model (architecture.md §3, §4):
  - 1 node = one (question, answer) pair.
  - Context for a turn = the ancestor chain ONLY (root -> ... -> parent),
    siblings excluded. node.connections (LCA memory-link) is Stage 3, ignored.
All writes go through the caller's RLS-scoped UserClient (owner-only).
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from ..db.client import UserClient

# Columns returned to the client for tree reconstruction.
# `connections` (uuid[]) lists other-branch nodes imported into this node, so the
# frontend can draw memory-link edges (Stage 3a).
# `reference_sources` (D46/0019) carries which branches an answer referenced this
# turn — without it the "참조 브랜치" chips/popup never render (D57).
# `attachments`(0001 jsonb)의 "canvas" 키는 캔버스 리프 노드(교과서 도판) 영속분 —
# 세션 재수화 때 FigureNode를 복원하려면 함께 내려줘야 한다(C5).
# D105: position_x/position_y는 select에서 뺐다 — 좌표의 소유자는 프론트
# d3-force이고 서버는 저장하지 않는다. 매 세션 조회마다 항상 NULL인 컬럼 두 개를
# 실어 보내고 있었다.
NODE_SELECT = (
    "id,session_id,parent_id,question,answer,label,"
    "connections,rag_sources,reference_sources,attachments,created_at"
)
SESSION_SELECT = (
    "id,owner_id,space_kind,space_ref,title,emoji,root_node_id,"
    "current_head_id,created_at,updated_at"
)


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


async def update_session_title(
    client: UserClient, session_id: str, title: str
) -> dict[str, Any]:
    """Rename a session (RLS sessions_update_owner -> owner only)."""
    rows = await client.update(
        "sessions",
        {"id": f"eq.{session_id}"},
        {"title": title},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or not yours.",
        )
    return rows[0]


async def delete_session(client: UserClient, session_id: str) -> None:
    """Delete a session (nodes cascade; files.session_id -> null, see 0011)."""
    await client.delete("sessions", {"id": f"eq.{session_id}"})


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
def ancestor_chain_nodes(
    nodes: list[dict[str, Any]], node_id: str | None
) -> list[dict[str, Any]]:
    """Ancestor chain node dicts (root -> ... -> node_id), siblings excluded."""
    if not node_id:
        return []
    by_id = {n["id"]: n for n in nodes}
    chain: list[dict[str, Any]] = []
    cursor = by_id.get(node_id)
    guard = 0
    while cursor is not None and guard < 10000:
        chain.append(cursor)
        cursor = by_id.get(cursor.get("parent_id"))
        guard += 1
    chain.reverse()  # root first
    return chain


def assemble_history(
    nodes: list[dict[str, Any]], parent_node_id: str | None
) -> list[tuple[str, str]]:
    """Ancestor chain (root -> ... -> parent) as ordered (question, answer)."""
    chain = ancestor_chain_nodes(nodes, parent_node_id)
    return [(n.get("question") or "", n.get("answer") or "") for n in chain]


async def append_node(
    client: UserClient,
    session_id: str,
    parent_id: str | None,
    question: str,
    answer: str,
    label: str | None,
) -> dict[str, Any]:
    """Atomically insert the (Q+A) node AND advance the session head/root.

    Backed by the append_chat_node() Postgres RPC (migration 0004) so the node
    can never be orphaned with a stale current_head_id. The RPC enforces
    ownership (sessions.owner_id = auth.uid()) inside the transaction.
    """
    result = await client.rpc(
        "append_chat_node",
        {
            "p_session_id": session_id,
            "p_parent_id": parent_id,
            "p_question": question,
            "p_answer": answer,
            "p_label": label,
        },
    )
    # A row-returning function may come back as a single object or a
    # one-element list, depending on how PostgREST resolves it.
    if isinstance(result, list):
        if not result:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Failed to save node.",
            )
        return result[0]
    return result

