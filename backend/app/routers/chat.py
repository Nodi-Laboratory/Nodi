"""Chat (SSE) — Stage 1 tree-conversation core.

Flow (architecture.md §4):
  1. Resolve parent (body.parent_node_id or session.current_head_id).
  2. Assemble ancestor-chain context (siblings excluded).
  3. Stream Gemini answer as SSE: start -> token* -> done (error on failure).
  4. Persist (question, answer) = 1 node, advance head (set root if first),
     auto-label (<=10 chars), and report the node in the `done` event.

SSE event schema:
  event: start      data: {"session_id","parent_node_id"}
  event: token      data: {"delta"}
  event: done       data: {"node":{"id","parent_id","label","tags":[...]},
                           "current_head_id","root_node_id"}
  event: navigator  data: {"nodes":[{"id","parent_id","navigator_question"}]}
  event: error      data: {"detail"}

Tagging (Stage 2 Part A): after the node is persisted, concept tags are
attached and returned INLINE in the `done` event (node.tags). Label and tag
extraction run concurrently to limit added latency; tagging is best-effort
(failure -> empty tags, never an error).

Navigator (Stage 2 Part B): after `done`, a gate may fire and create waiting
is_navigator nodes; when it does, a separate `navigator` event carries them.
Generated INLINE (not a background job) under the caller's JWT — see
services/navigator.py for the rationale. Best-effort: never blocks the turn.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..services import gemini, memory, navigator, rag
from ..services import sessions as svc
from ..services import tagging
from ..services.supabase_client import UserClient
from ..services.turn_log import TurnLog

logger = logging.getLogger("nodi.chat")
router = APIRouter(prefix="/chat", tags=["chat"])

QUESTION_MAX_CHARS = 8000


class NavigatorOverride(BaseModel):
    """D47 per-request navigator preference (clamped server-side, navigator.py).

    All optional; missing fields fall back to the admin/config default. `enabled`
    False disables navigator generation for this turn entirely.
    """

    enabled: bool | None = None
    count: int | None = None
    gate_k: int | None = None
    period: int | None = None


class ChatStreamBody(BaseModel):
    session_id: str
    question: str = Field(min_length=1, max_length=QUESTION_MAX_CHARS)
    parent_node_id: str | None = None
    # D15: one-time branch comparison — other nodes to reference for THIS turn
    # only (not persisted, does not touch node.connections).
    reference_node_ids: list[str] | None = Field(default=None, max_length=20)
    # D47: per-request navigator override (user workspace settings).
    navigator: NavigatorOverride | None = None


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
    chain = svc.ancestor_chain_nodes(nodes, parent_id)
    history = [
        (n.get("question") or "", n.get("answer") or "")
        for n in chain
        if not n.get("is_navigator")
    ]
    # Imported other-branch context via node connections (LCA-trimmed, Stage 3a).
    # Best-effort: never blocks the turn. Also returns the imported node ids (D35).
    reference_context, reference_node_ids = await memory.build_reference_context(
        client, body.session_id, chain, {n["id"]: n for n in nodes}
    )
    # Visual RAG: chunks from files linked to this branch (Stage 3b-2). Structured
    # result carries the injection block AND per-chunk source metadata (D32).
    rag_result = await rag.build_rag_context(client, chain, body.question)
    rag_context = rag_result["block"] if rag_result else None
    rag_sources = rag_result["sources"] if rag_result else []
    # One-time branch comparison references (D15) — injected this turn; the
    # source branches are persisted on the answer node for the UI (D46).
    # current_chain/by_id let same-session references be LCA-trimmed.
    (
        comparison_context,
        comparison_node_ids,
        comparison_sources,
    ) = await memory.build_comparison_context(
        client, body.reference_node_ids or [], chain, {n["id"]: n for n in nodes}
    )
    existing_root = session.get("root_node_id")

    # Turn log (D25) + structured prompt composition (D35). compose_system_structured
    # is the SINGLE source of truth for both the system prompt string AND each
    # block's char span, so the saved prompt and the admin highlight never drift.
    system_prompt, context_blocks = gemini.compose_system_structured(
        reference_context,
        rag_context,
        comparison_context,
        rag_sources=rag_sources,
        reference_node_ids=reference_node_ids,
        comparison_node_ids=comparison_node_ids,
    )
    tlog = TurnLog(user.id, body.session_id, body.question)
    tlog.set_system(system_prompt)
    tlog.set_contexts_structured(
        blocks=context_blocks,
        history_turns=len(history),
        history_chars=sum(len(q) + len(a) for q, a in history),
    )

    async def event_stream():
        yield _sse(
            "start",
            {"session_id": body.session_id, "parent_node_id": parent_id},
        )
        answer_parts: list[str] = []
        try:
            try:
                async for delta in gemini.stream_answer(
                    history,
                    body.question,
                    reference_context=reference_context,
                    rag_context=rag_context,
                    comparison_context=comparison_context,
                ):
                    answer_parts.append(delta)
                    yield _sse("token", {"delta": delta})
            except Exception:  # noqa: BLE001 - details go to logs, not the client
                logger.exception("Gemini streaming failed")
                tlog.add_error("ai_streaming_failed")
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
                tlog.add_error("empty_answer")
                yield _sse("error", {"detail": "응답을 생성하지 못했습니다."})
                return

            try:
                # Label + concept extraction run concurrently (both read Q+A).
                # Label (best-effort) is needed for the atomic node insert; tag
                # names are linked right after we have the node id.
                label, tag_names = await asyncio.gather(
                    gemini.generate_label(body.question, answer),
                    tagging.extract_concepts(body.question, answer),
                )
                node = await svc.append_node(
                    client, body.session_id, parent_id, body.question, answer, label
                )
                tlog.set_final(node["id"], answer)
                # D32: persist the answer's RAG provenance on the node so the
                # source chips can be shown when the answer is re-opened.
                # Best-effort — a provenance write must not fail the saved turn.
                if rag_sources:
                    try:
                        await client.update(
                            "nodes",
                            {"id": f"eq.{node['id']}"},
                            {"rag_sources": rag_sources},
                        )
                    except Exception:  # noqa: BLE001
                        logger.warning(
                            "rag_sources persist failed node=%s", node["id"]
                        )
                # D46: persist which branches this answer referenced so the UI
                # can show source chips + branch buttons when the node reopens.
                # Best-effort — a provenance write must not fail the saved turn.
                if comparison_sources:
                    try:
                        await client.update(
                            "nodes",
                            {"id": f"eq.{node['id']}"},
                            {"reference_sources": comparison_sources},
                        )
                    except Exception:  # noqa: BLE001
                        logger.warning(
                            "reference_sources persist failed node=%s", node["id"]
                        )
                # Best-effort: reuse-or-create + link tags. A tag failure must
                # NOT turn into a "save failed" — the node is already persisted.
                try:
                    tags = await tagging.apply_node_tags(
                        client, node["id"], body.session_id, tag_names
                    )
                except Exception:  # noqa: BLE001
                    logger.exception("Tag application failed node=%s", node["id"])
                    tlog.add_error("tag_apply_failed")
                    tags = []
                tlog.add_skill("tagging", count=len(tags))
                yield _sse(
                    "done",
                    {
                        "node": {
                            "id": node["id"],
                            "parent_id": node.get("parent_id"),
                            "label": node.get("label"),
                            "tags": tags,
                            # D57: surface the same reference provenance we just
                            # persisted so the "참조 브랜치" chips/popup show
                            # immediately (before the trailing session refetch),
                            # matching what NODE_SELECT now reads back. [] when
                            # this turn referenced no other branch.
                            "reference_sources": comparison_sources or [],
                        },
                        "current_head_id": node["id"],
                        "root_node_id": existing_root or node["id"],
                    },
                )

                # Navigator gate (best-effort, INLINE — see navigator.py). Runs
                # AFTER `done` so the answer is already shown; only fires when the
                # branch matured. A failure never affects the saved node.
                try:
                    all_nodes = await svc.get_session_nodes(client, body.session_id)
                    nav_nodes = await navigator.maybe_generate(
                        client,
                        user.id,
                        body.session_id,
                        node["id"],
                        all_nodes,
                        override=(
                            body.navigator.model_dump()
                            if body.navigator is not None
                            else None
                        ),
                    )
                    if nav_nodes:
                        tlog.add_skill("navigator", count=len(nav_nodes))
                        yield _sse("navigator", {"nodes": nav_nodes})
                except Exception:  # noqa: BLE001 - navigator is optional
                    logger.exception("Navigator generation failed")
                    tlog.add_error("navigator_failed")
            except Exception:  # noqa: BLE001 - details to logs, not the client
                logger.exception("Persisting node failed")
                tlog.add_error("save_failed")
                yield _sse("error", {"detail": "답변 저장에 실패했습니다."})
        finally:
            # Persist the turn log exactly once (best-effort).
            await tlog.save(client)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
