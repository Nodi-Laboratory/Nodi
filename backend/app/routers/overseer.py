"""Overseer endpoint — home navigational AI (SSE).

POST /overseer/stream  body {message}
  event: start   data: {}
  event: token   data: {"delta"}
  event: done    data: {"actions": [ ... ]}      # buttons (see services/overseer)
  event: error   data: {"detail"}

SSE chosen to match the chat pattern (real token streaming). The action buttons
are computed deterministically from the workspace snapshot, so they are reliable
without a second LLM round-trip and are delivered in the `done` event.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..services import gemini, overseer
from ..services.supabase_client import UserClient

logger = logging.getLogger("nodi.overseer.router")
router = APIRouter(prefix="/overseer", tags=["overseer"])

MESSAGE_MAX_CHARS = 4000


class OverseerBody(BaseModel):
    message: str = Field(min_length=1, max_length=MESSAGE_MAX_CHARS)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/stream")
async def overseer_stream(
    body: OverseerBody,
    user: CurrentUser = Depends(get_current_user),
) -> StreamingResponse:
    client = UserClient.from_user(user)

    # Snapshot (RLS read-skills) resolved BEFORE streaming so failures are plain
    # HTTP errors, not mid-stream.
    data = await overseer.gather(client, user.id, body.message)

    async def event_stream():
        yield _sse("start", {})
        try:
            async for delta in gemini.stream_overseer(
                data["snapshot"], body.message
            ):
                yield _sse("token", {"delta": delta})
        except Exception:  # noqa: BLE001 - details to logs, not client
            logger.exception("Overseer streaming failed")
            yield _sse("error", {"detail": "총괄 AI 응답 생성에 실패했습니다."})
            return
        actions = overseer.build_actions(user.id, body.message, data)
        yield _sse("done", {"actions": actions})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
