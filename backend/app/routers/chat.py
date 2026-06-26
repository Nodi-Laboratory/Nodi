"""Chat (SSE) — PLACEHOLDER for Stage 0.

The real implementation arrives in Stage 1 (todo.md 단계 1): Gemini SSE
streaming, (Q+A)=1 node persistence, ancestor-chain context assembly, and the
ReAct orchestrator emitting start/tool_call/tool_result/token/
confirmation_required/done events (architecture.md §2, §4).

This module only reserves the route surface so the frontend contract is known.
Do NOT implement chat logic here yet.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth.deps import CurrentUser, get_current_user

router = APIRouter(prefix="/chat", tags=["chat"])


@router.post("/stream", status_code=status.HTTP_501_NOT_IMPLEMENTED)
async def chat_stream(_user: CurrentUser = Depends(get_current_user)) -> dict:
    """Placeholder. Will become a `text/event-stream` SSE endpoint in Stage 1."""
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Chat SSE is not implemented in Stage 0.",
    )
