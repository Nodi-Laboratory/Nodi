"""Chat (SSE) — concept-card conversation core (EXAONE).

Flow:
  1. Resolve parent (body.parent_node_id or session.current_head_id).
  2. Assemble ancestor-chain context (siblings excluded).
  3. Stream the EXAONE answer as SSE: start -> token* -> done (error on failure).
     The answer is the structured concept-card format (CHAT:/@concept/…/@end);
     the frontend parser turns the token stream into cards. Card layout + camera
     are owned by the frontend (d3-force) — the server no longer computes/sends
     positions.
  4. Persist (question, structured-answer) = 1 node with a NULL label, advance
     head (set root if first), and report the node in the `done` event.
  5. After done: a fire-and-forget task patches nodes.attachments.canvas with the
     ebs/art search results only (best-effort, log only on failure). No card
     coordinates, embedding, or canvas_cards.

SSE event schema:
  event: start   data: {"session_id","parent_node_id"}
  event: token   data: {"delta"}
  event: done    data: {"node":{"id","parent_id","label":null,
                        "reference_sources":[...],"rag_sources":[...]},
                        "current_head_id","root_node_id"}
  event: error   data: {"detail"}
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..services import exaone, gemini, memory, rag
from ..services import sessions as svc
from ..services.supabase_client import UserClient
from ..services.turn_log import TurnLog
from ..config import get_settings

logger = logging.getLogger("nodi.chat")
router = APIRouter(prefix="/chat", tags=["chat"])
settings = get_settings()

QUESTION_MAX_CHARS = 8000


class RetrievedEbsItem(BaseModel):
    """프론트가 /retrieve에서 받은 EBS 항목 — snake_case로 서버 전달."""
    video_id: str
    title: str
    thumb: str
    score: float


class RetrievedArtItem(BaseModel):
    """프론트가 /retrieve에서 받은 삽화 항목."""
    slug: str
    url: str
    title: str
    score: float


class RetrievedBody(BaseModel):
    """done 훅에서 attachments.canvas에 통합 저장할 ebs/art 검색 결과."""
    ebs: list[RetrievedEbsItem] = Field(default_factory=list)
    art: list[RetrievedArtItem] = Field(default_factory=list)


class ChatStreamBody(BaseModel):
    session_id: str
    question: str = Field(min_length=1, max_length=QUESTION_MAX_CHARS)
    parent_node_id: str | None = None
    # D15: one-time branch comparison — other nodes to reference for THIS turn
    # only (not persisted, does not touch node.connections).
    reference_node_ids: list[str] | None = Field(default=None, max_length=20)
    # 09 단일 writer: 프론트 retrieve 결과(ebs/art)를 서버에 전달해 done 훅이
    # ebs/art를 attachments.canvas에 저장. null이면 저장하지 않음(첫 질문 전
    # degraded 케이스 등). 카드 좌표는 프론트 소유 — 서버는 저장하지 않음.
    retrieved: RetrievedBody | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _patch_canvas_unified(
    client: UserClient, node_id: str, retrieved: RetrievedBody | None = None,
) -> None:
    """nodes.attachments.canvas에 ebs/art만 저장(카드 좌표는 프론트 소유 — 저장 안 함)."""
    if retrieved is None:
        return
    try:
        rows = await client.select("nodes", {"id": f"eq.{node_id}", "select": "id,attachments", "limit": "1"})
        if not rows:
            return
        attachments = rows[0].get("attachments") or {}
        if not isinstance(attachments, dict):
            attachments = {}
        attachments["canvas"] = {
            "ebs": [e.model_dump() for e in retrieved.ebs],
            "art": [a.model_dump() for a in retrieved.art],
        }
        await client.update("nodes", {"id": f"eq.{node_id}"}, {"attachments": attachments})
    except Exception:  # noqa: BLE001
        logger.warning("attachments.canvas(ebs/art) 저장 실패 node=%s", node_id, exc_info=True)


@router.post("/stream")
async def chat_stream(
    body: ChatStreamBody,
    user: CurrentUser = Depends(get_current_user),
) -> StreamingResponse:
    client = UserClient.from_user(user)

    # Validate access + resolve context BEFORE streaming so auth/404 errors are
    # plain HTTP responses (not mid-stream SSE errors). Session meta and the node
    # list are independent reads -> fetch concurrently (D66). A 404 from
    # get_session still propagates out of gather as a plain HTTP error.
    session, nodes = await asyncio.gather(
        svc.get_session(client, body.session_id),
        svc.get_session_nodes(client, body.session_id),
    )

    # Only the session OWNER may write nodes. Reject up front (saves AI tokens):
    # a class teacher can SELECT a class session but must not stream into it.
    if session.get("owner_id") != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the session owner can chat in this session.",
        )

    parent_id = body.parent_node_id or session.get("current_head_id")
    chain = svc.ancestor_chain_nodes(nodes, parent_id)
    by_id = {n["id"]: n for n in nodes}
    history = [(n.get("question") or "", n.get("answer") or "") for n in chain]
    # All three context builders read the same ancestor chain but are otherwise
    # independent, and each is internally best-effort (own try/except, safe
    # defaults on failure). Run them concurrently to cut first-token latency —
    # the RAG builder's question-embedding Gemini call is the heaviest leg (D66).
    #   - reference:  imported other-branch context (node connections, LCA-trimmed, 3a, D35)
    #   - rag:        chunks from files linked to this branch (Stage 3b-2, D32 sources)
    #   - comparison: one-time branch references for THIS turn (D15/D46, LCA-trimmed)
    (
        (reference_context, reference_node_ids),
        rag_result,
        (comparison_context, comparison_node_ids, comparison_sources),
    ) = await asyncio.gather(
        memory.build_reference_context(client, body.session_id, chain, by_id),
        rag.build_rag_context(
            client,
            chain,
            body.question,
            # D73: 학급 세션이면 class_material 자동 스코프 — 세션 행에 이미
            # space_kind/space_ref가 있어 추가 조회 없음(SESSION_SELECT).
            space_kind=session.get("space_kind"),
            space_ref=session.get("space_ref"),
        ),
        memory.build_comparison_context(
            client, body.reference_node_ids or [], chain, by_id
        ),
    )
    rag_context = rag_result["block"] if rag_result else None
    rag_sources = rag_result["sources"] if rag_result else []
    existing_root = session.get("root_node_id")

    # Turn log (D25) + structured prompt composition (D35). compose_system_structured
    # is the SINGLE source of truth for both the system prompt string AND each
    # block's char span, so the saved prompt and the admin highlight never drift.
    system_prompt, context_blocks_list = gemini.compose_system_structured(
        reference_context,
        rag_context,
        comparison_context,
        rag_sources=rag_sources,
        reference_node_ids=reference_node_ids,
        comparison_node_ids=comparison_node_ids,
        base_instruction=exaone.CONCEPT_CARD_SYSTEM_PROMPT,
    )
    tlog = TurnLog(user.id, body.session_id, body.question)
    tlog.set_system(system_prompt)
    tlog.set_contexts_structured(
        blocks=context_blocks_list,
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
                async for delta in exaone.stream_answer(
                    history,
                    body.question,
                    system_prompt,
                ):
                    answer_parts.append(delta)
                    yield _sse("token", {"delta": delta})

            except Exception:  # noqa: BLE001 - details go to logs, not the client
                logger.exception("EXAONE streaming failed")
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
                # Labels + concept tags are REMOVED (design decision): persist
                # just the (question, structured-answer) node with a null label.
                # The frontend parses the answer text into concept cards; concept
                # grouping + illustrations are resolved client-side via
                # /art/search.
                node = await svc.append_node(
                    client, body.session_id, parent_id, body.question, answer, None
                )
                tlog.set_final(node["id"], answer)
                # D32/D46: persist any answer provenance (rag/reference). In the
                # concept-card UI these are normally empty, but keep the write so
                # the (unrouted) tree UI still shows source chips. One PATCH,
                # best-effort — never fails the already-saved turn.
                provenance: dict = {}
                if rag_sources:
                    provenance["rag_sources"] = rag_sources
                if comparison_sources:
                    provenance["reference_sources"] = comparison_sources
                if provenance:
                    try:
                        await client.update(
                            "nodes", {"id": f"eq.{node['id']}"}, provenance
                        )
                    except Exception:  # noqa: BLE001
                        logger.warning(
                            "provenance persist failed node=%s", node["id"]
                        )

                yield _sse(
                    "done",
                    {
                        "node": {
                            "id": node["id"],
                            "parent_id": node.get("parent_id"),
                            "label": None,
                            "reference_sources": comparison_sources or [],
                            # D74: 실시간 출처 칩 표시용(영속은 위 PATCH가 담당).
                            "rag_sources": rag_sources or [],
                        },
                        "current_head_id": node["id"],
                        "root_node_id": existing_root or node["id"],
                    },
                )

                # attachments.canvas 저장(ebs/art만) — 카드 좌표는 프론트 소유.
                # 자체 격리: 저장이 실패해도 스트림/저장 완료된 턴은 무영향(warning만).
                # retrieved 없으면 _patch_canvas_unified가 조기 반환.
                if body.retrieved is not None:
                    asyncio.create_task(
                        _patch_canvas_unified(client, node["id"], body.retrieved)
                    )

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
