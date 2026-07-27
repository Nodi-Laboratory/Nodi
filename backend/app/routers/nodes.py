"""Node endpoints — memory-link connections (Stage 3a).

- POST   /nodes/{id}/connections           link another branch's node in
- DELETE /nodes/{id}/connections/{src}     unlink it

Connections power "node memory linking": a node's `connections uuid[]` lists
other-branch nodes pulled into it; chat context assembly LCA-trims and injects
them as reference (see services/memory.py). All writes are owner-only (RLS +
the add/remove RPCs in migration 0007).

D105: 좌표 영속 엔드포인트(POST /positions, PATCH /{id}, PATCH /{id}/position)는
제거됐다. 카드 좌표의 소유자는 프론트 d3-force 시뮬레이션이고(useTagLayout),
서버는 답변 원문만 저장한다 — 좌표를 받아 적을 곳 자체가 없다.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..auth.deps import CurrentUser, get_current_user
from ..db.client import UserClient

router = APIRouter(prefix="/nodes", tags=["nodes"])


class ConnectionBody(BaseModel):
    source_node_id: str


def _connections(result: object) -> list[str]:
    """Normalize the RPC's uuid[] return into a list of strings."""
    if isinstance(result, list):
        return [str(x) for x in result]
    return []


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

