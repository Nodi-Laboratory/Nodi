"""Node endpoints — canvas persistence + memory-link connections (Stage 3a).

- PATCH  /nodes/{id}                       canvas state (coords + attachments)
- PATCH  /nodes/{id}/position              persist a single node's coordinates
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


class CanvasPatchBody(BaseModel):
    """개념 캔버스 영속화(§8) — 좌표 + 검색 결과. None 필드는 건드리지 않는다."""

    position_x: float | None = None
    position_y: float | None = None
    # /retrieve 결과 {"figures":[...]} — attachments.canvas 키로 병합.
    attachments_canvas: dict | None = None


def _connections(result: object) -> list[str]:
    """Normalize the RPC's uuid[] return into a list of strings."""
    if isinstance(result, list):
        return [str(x) for x in result]
    return []


@router.patch("/{node_id}")
async def patch_node_canvas(
    node_id: str,
    body: CanvasPatchBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """캔버스 상태 PATCH — 좌표 저장 + attachments.canvas 병합 (소유자 전용, RLS).

    attachments는 read-modify-write로 "canvas" 키만 갱신 — 다른 attachment
    키(provenance 등)는 보존한다. 프론트는 chat done 후 fire-and-forget 호출.
    """
    client = UserClient.from_user(user)
    rows = await client.select(
        "nodes",
        {
            "id": f"eq.{node_id}",
            "select": "id,position_x,position_y,attachments",
            "limit": "1",
        },
    )
    if not rows:
        # 없는 노드거나 RLS가 숨김(타인 세션) — 동일하게 404.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Node not found or not yours.",
        )
    current = rows[0]

    patch: dict = {}
    if body.position_x is not None:
        patch["position_x"] = body.position_x
    if body.position_y is not None:
        patch["position_y"] = body.position_y
    if body.attachments_canvas is not None:
        attachments = current.get("attachments")
        if not isinstance(attachments, dict):
            attachments = {}
        attachments["canvas"] = body.attachments_canvas
        patch["attachments"] = attachments

    if not patch:
        return {
            "id": node_id,
            "position_x": current.get("position_x"),
            "position_y": current.get("position_y"),
            "attachments": current.get("attachments") or {},
        }

    updated = await client.update("nodes", {"id": f"eq.{node_id}"}, patch)
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Node not found or not yours.",
        )
    row = updated[0]
    return {
        "id": node_id,
        "position_x": row.get("position_x"),
        "position_y": row.get("position_y"),
        "attachments": row.get("attachments") or {},
    }


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
