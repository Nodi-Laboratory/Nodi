"""Chat (SSE) — Stage 1 tree-conversation core.

Flow (architecture.md §4):
  1. Resolve parent (body.parent_node_id or session.current_head_id).
  2. Assemble ancestor-chain context (siblings excluded).
  3. Stream Gemini answer as SSE: start -> token* -> done (error on failure).
  4. Persist (question, answer) = 1 node, advance head (set root if first),
     auto-label (<=10 chars), and report the node in the `done` event.

SSE event schema:
  event: start  data: {"session_id","parent_node_id"}
  event: token  data: {"delta"}
  event: done   data: {"node":{"id","parent_id","label"},
                        "current_head_id","root_node_id"}
  event: error  data: {"detail"}
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..services import gemini
from ..services import sessions as svc
from ..services.supabase_client import UserClient

logger = logging.getLogger("nodi.chat")
router = APIRouter(prefix="/chat", tags=["chat"])

QUESTION_MAX_CHARS = 8000


class ChatStreamBody(BaseModel):
    session_id: str
    question: str = Field(min_length=1, max_length=QUESTION_MAX_CHARS)
    parent_node_id: str | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/stream")
async def chat_stream(
    body: ChatStreamBody,
    user: CurrentUser = Depends(get_current_user),
) -> StreamingResponse:
    client = UserClient.from_user(user)

    # Validate access + resolve context BEFORE streaming so auth/404 errors are
    # plain HTTP responses (not mid-stream SSE errors).
    session = await svc.get_session(client, body.session_id)

    # Only the session OWNER may write nodes. Reject up front (saves AI tokens):
    # a class teacher can SELECT a class session but must not stream into it.
    if session.get("owner_id") != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the session owner can chat in this session.",
        )

    parent_id = body.parent_node_id or session.get("current_head_id")
    nodes = await svc.get_session_nodes(client, body.session_id)
    history = svc.assemble_history(nodes, parent_id)
    existing_root = session.get("root_node_id")

    async def event_stream():
        yield _sse(
            "start",
            {"session_id": body.session_id, "parent_node_id": parent_id},
        )
        answer_parts: list[str] = []
        try:
            async for delta in gemini.stream_answer(history, body.question):
                answer_parts.append(delta)
                yield _sse("token", {"delta": delta})
        except Exception:  # noqa: BLE001 - details go to logs, not the client
            logger.exception("Gemini streaming failed")
            yield _sse("error", {"detail": "AI 응답 생성에 실패했습니다."})
            return

        answer = "".join(answer_parts).strip()
        if not answer:
            # Empty answer (e.g. safety block / no tokens): do NOT persist a
            # blank node or advance the head — leave the tree unchanged.
            logger.warning(
                "Empty answer for session=%s; skipping node save.",
                body.session_id,
            )
            yield _sse("error", {"detail": "응답을 생성하지 못했습니다."})
            return

        try:
            # Label first (best-effort, None on failure) so node insert + head
            # advance + label are one atomic RPC transaction.
            label = await gemini.generate_label(body.question, answer)
            node = await svc.append_node(
                client, body.session_id, parent_id, body.question, answer, label
            )
            yield _sse(
                "done",
                {
                    "node": {
                        "id": node["id"],
                        "parent_id": node.get("parent_id"),
                        "label": node.get("label"),
                    },
                    "current_head_id": node["id"],
                    "root_node_id": existing_root or node["id"],
                },
            )
        except Exception:  # noqa: BLE001 - details go to logs, not the client
            logger.exception("Persisting node failed")
            yield _sse("error", {"detail": "답변 저장에 실패했습니다."})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
