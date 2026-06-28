"""Node endpoints — navigator cleanup + memory-link connections (Stage 3a).

- DELETE /nodes/{id}                       navigator-node cleanup
- POST   /nodes/{id}/connections           link another branch's node in
- DELETE /nodes/{id}/connections/{src}     unlink it

Connections power "node memory linking": a node's `connections uuid[]` lists
other-branch nodes pulled into it; chat context assembly LCA-trims and injects
them as reference (see services/memory.py). All writes are owner-only (RLS +
the add/remove RPCs in migration 0007).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..auth.deps import CurrentUser, get_current_user
from ..services.supabase_client import UserClient

router = APIRouter(prefix="/nodes", tags=["nodes"])


class ConnectionBody(BaseModel):
    source_node_id: str


class PositionBody(BaseModel):
    position_x: float | None = None
    position_y: float | None = None


def _connections(result: object) -> list[str]:
    """Normalize the RPC's uuid[] return into a list of strings."""
    if isinstance(result, list):
        return [str(x) for x in result]
    return []


@router.delete("/{node_id}", status_code=204)
async def delete_node(
    node_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> None:
    client = UserClient.from_user(user)
    rows = await client.select(
        "nodes",
        {"id": f"eq.{node_id}", "select": "id,is_navigator", "limit": "1"},
    )
    if not rows:
        # Either it does not exist or RLS hid it (not the caller's session).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Node not found.",
        )
    if not rows[0].get("is_navigator"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only navigator nodes can be deleted via this endpoint.",
        )
    # RLS (nodes_delete_owner) still enforces ownership at the DB layer.
    await client.delete("nodes", {"id": f"eq.{node_id}"})


@router.patch("/{node_id}/position")
async def set_node_position(
    node_id: str,
    body: PositionBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Persist a single node's coordinates (D20). Owner only (RLS)."""
    client = UserClient.from_user(user)
    rows = await client.update(
        "nodes",
        {"id": f"eq.{node_id}"},
        {"position_x": body.position_x, "position_y": body.position_y},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Node not found or not yours.",
        )
    return {"id": node_id, "position_x": body.position_x, "position_y": body.position_y}


@router.post("/{node_id}/connections")
async def add_connection(
    node_id: str,
    body: ConnectionBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Link `source_node_id` (another owned branch/session node) into this node.

    Idempotent (no duplicates). Both nodes must be owned by the caller; the RPC
    enforces this. Returns the updated connections array.
    """
    if body.source_node_id == node_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A node cannot be connected to itself.",
        )
    client = UserClient.from_user(user)
    result = await client.rpc(
        "add_node_connection",
        {"p_node_id": node_id, "p_source_node_id": body.source_node_id},
    )
    return {"node_id": node_id, "connections": _connections(result)}


@router.delete("/{node_id}/connections/{source_node_id}")
async def remove_connection(
    node_id: str,
    source_node_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Unlink `source_node_id` from this node. Returns updated connections."""
    client = UserClient.from_user(user)
    result = await client.rpc(
        "remove_node_connection",
        {"p_node_id": node_id, "p_source_node_id": source_node_id},
    )
    return {"node_id": node_id, "connections": _connections(result)}
