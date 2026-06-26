"""Node endpoints — navigator cleanup.

When the user clicks a navigator suggestion, the frontend sends that
`navigator_question` as a real chat turn (POST /chat/stream with parent_node_id
= the navigator node's parent), then DELETEs the waiting navigator node here.

Scope: only the caller's own nodes (RLS nodes_delete_owner) AND only
is_navigator nodes — this endpoint is for navigator cleanup, not general tree
editing, so it cannot be used to corrupt the conversation tree.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth.deps import CurrentUser, get_current_user
from ..services.supabase_client import UserClient

router = APIRouter(prefix="/nodes", tags=["nodes"])


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
