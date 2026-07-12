"""Chat (SSE) — concept-card conversation core (EXAONE).

Flow:
  1. Resolve parent (body.parent_node_id or session.current_head_id).
  2. Assemble ancestor-chain context (siblings excluded).
  3. Stream the EXAONE answer as SSE: start -> token* -> place* -> done (error on failure).
     The answer is the structured concept-card format (CHAT:/@concept/…/@end);
     the frontend parser turns the token stream into cards.
  4. During streaming, scan line buffer for "@concept:" lines — emit `place` SSE
     immediately with the computed (x, y) for that concept_index.
  5. Persist (question, structured-answer) = 1 node with a NULL label, advance
     head (set root if first), and report the node in the `done` event.
  6. After done: fire-and-forget task embeds concepts + upserts canvas_cards
     + patches nodes.attachments.canvas.concepts (best-effort, log only on failure).

SSE event schema:
  event: start   data: {"session_id","parent_node_id"}
  event: token   data: {"delta"}
  event: place   data: {"concept_index": int, "x": int, "y": int}
  event: done    data: {"node":{"id","parent_id","label":null,"tags":[],
                        "reference_sources":[...]},
                        "current_head_id","root_node_id"}
  event: error   data: {"detail"}
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..services import exaone, gemini, memory, rag
from ..services import sessions as svc
from ..services import concept_blocks, qdrant_store, upstage
from ..services.canvas_layout import (
    build_occupied,
    cell_to_xy,
    fallback_anchor,
    nearest_free_cell,
    xy_to_cell,
)
from ..services.supabase_client import UserClient
from ..services.turn_log import TurnLog
from ..config import get_settings

logger = logging.getLogger("nodi.chat")
router = APIRouter(prefix="/chat", tags=["chat"])
settings = get_settings()

QUESTION_MAX_CHARS = 8000

_CONCEPT_LINE_RE = re.compile(r"^@concept:\s*(.*)$")


class NavigatorOverride(BaseModel):
    """D47 per-request navigator preference (clamped server-side, navigator.py).

    All optional; missing fields fall back to the admin/config default. `enabled`
    False disables navigator generation for this turn entirely.
    """

    enabled: bool | None = None
    count: int | None = None
    gate_k: int | None = None
    period: int | None = None


class PlaceHint(BaseModel):
    """프론트가 /retrieve near를 릴레이하는 초기 배치 힌트."""

    x: int
    y: int


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
    # D47: per-request navigator override (user workspace settings).
    # 프론트 구계약 호환용 — 수신만 하고 무시한다(네비게이터 생성은 제거됨).
    navigator: NavigatorOverride | None = None
    # 서버 권위 좌표 — /retrieve near를 릴레이. null이면 서버가 폴백 계산.
    place_hint: PlaceHint | None = None
    # 09 단일 writer: 프론트 retrieve 결과(ebs/art)를 서버에 전달해 done 훅이
    # concepts + ebs/art를 한 번의 PATCH로 attachments.canvas에 통합 저장.
    # null이면 ebs/art는 저장하지 않음(첫 질문 전 degraded 케이스 등).
    retrieved: RetrievedBody | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _scroll_session_cards(owner_id: str, session_id: str) -> list[dict]:
    """세션 기존 canvas_cards scroll — best-effort, 실패(Qdrant 다운) 시 [].

    스트림당 1회 호출해 결과를 두 용도로 재사용한다(조회 중복 없음):
      (1) place_hint 없을 때 폴백 앵커 계산
      (2) place 점유 셋 시딩 — place_hint 셀이 기존 카드로 점유돼 있으면
          nearest_free_cell이 곁 빈 셀로 스냅하도록.
    """
    try:
        return await qdrant_store.scroll_canvas_cards(
            owner_id=owner_id, session_id=session_id
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "canvas_cards scroll 실패 — 빈 점유 셋으로 진행 session=%s",
            session_id,
            exc_info=True,
        )
        return []


async def _save_canvas_cards(
    client: UserClient,
    user_id: str,
    session_id: str,
    node_id: str,
    answer: str,
    placed_coords: dict[int, tuple[int, int]],
    retrieved: RetrievedBody | None = None,
) -> None:
    """done 훅 — fire-and-forget: 개념 임베딩 + canvas_cards upsert + attachments 병합.

    실패는 logger.warning만 — 스트림/답변 저장에 영향 없음.
    """
    try:
        blocks = concept_blocks.parse(answer)
        if not blocks:
            return

        # 개념 텍스트 목록 구성 (제목 + 본문)
        texts = [f"{b['title']}\n{b['body']}" for b in blocks]

        # Upstage embedding-passage 배치 1회
        vectors = await upstage.embed_passages(texts)

        points = []
        concepts_meta: list[dict] = []
        now = time.time()

        for b, vec in zip(blocks, vectors):
            # concept_blocks.parse의 index는 답변 내 0-based 로컬 인덱스 —
            # place SSE의 concept_index·concepts[].i와 같은 좌표계다.
            idx = b["index"]
            coord = placed_coords.get(idx)
            if coord is None:
                continue  # place 이벤트가 방출되지 않은 개념은 스킵
            x, y = coord
            point_id = qdrant_store.canvas_card_point_id(node_id, idx)
            points.append(
                {
                    "id": point_id,
                    "vector": vec,
                    "payload": {
                        "owner_id": user_id,
                        "session_id": session_id,
                        "node_id": node_id,
                        "concept_index": idx,
                        "title": b["title"],
                        "x": x,
                        "y": y,
                        "created_at": now,
                    },
                }
            )
            concepts_meta.append({"i": idx, "x": x, "y": y})

        if points:
            await qdrant_store.upsert(qdrant_store.COL_CANVAS_CARDS, points)

        # attachments.canvas 단일 writer PATCH — concepts + ebs/art 통합
        if concepts_meta:
            await _patch_canvas_unified(client, node_id, concepts_meta, retrieved)

    except Exception:  # noqa: BLE001
        logger.warning(
            "canvas_cards 저장 실패 node=%s — 다음 kNN에서 해당 카드 누락",
            node_id,
            exc_info=True,
        )


async def _patch_canvas_unified(
    client: UserClient,
    node_id: str,
    concepts_meta: list[dict],
    retrieved: RetrievedBody | None = None,
) -> None:
    """nodes.attachments.canvas 단일 writer PATCH.

    concepts 좌표 + ebs/art를 한 번의 PATCH로 저장해 이중 writer RMW 레이스를
    방지한다. 프론트 patchNodeCanvas(ebs/art)는 더 이상 호출하지 않음(09 계약).

    계약(프론트와 공유): concepts[].i는 "이 답변(노드) 내 0-based 로컬
    인덱스" — place SSE의 concept_index와 동일한 의미. 프론트 리플레이가
    이 가정으로 좌표를 매칭한다.
    """
    try:
        rows = await client.select(
            "nodes",
            {"id": f"eq.{node_id}", "select": "id,attachments", "limit": "1"},
        )
        if not rows:
            return
        attachments = rows[0].get("attachments") or {}
        if not isinstance(attachments, dict):
            attachments = {}
        canvas: dict = {}
        canvas["concepts"] = concepts_meta
        if retrieved is not None:
            canvas["ebs"] = [e.model_dump() for e in retrieved.ebs]
            canvas["art"] = [a.model_dump() for a in retrieved.art]
        attachments["canvas"] = canvas
        await client.update("nodes", {"id": f"eq.{node_id}"}, {"attachments": attachments})
    except Exception:  # noqa: BLE001
        logger.warning("attachments.canvas 병합 실패 node=%s", node_id, exc_info=True)


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
    history = [
        (n.get("question") or "", n.get("answer") or "")
        for n in chain
        if not n.get("is_navigator")
    ]
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
        rag.build_rag_context(client, chain, body.question),
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

    # 스트림 시작 전 1회 scroll: 폴백 앵커 + place 점유 셋 시딩에 재사용.
    session_cards = await _scroll_session_cards(user.id, body.session_id)
    if body.place_hint is not None:
        hint_anchor = xy_to_cell(body.place_hint.x, body.place_hint.y)
    else:
        hint_anchor = fallback_anchor(session_cards)

    async def event_stream():
        yield _sse(
            "start",
            {"session_id": body.session_id, "parent_node_id": parent_id},
        )
        answer_parts: list[str] = []

        # place 이벤트 계산용 스트림-스코프 상태
        # placed_coords: {concept_index: (x, y)} — done 훅에서 재사용
        placed_coords: dict[int, tuple[int, int]] = {}
        concept_count = 0
        # 점유 셀 집합 — 세션 기존 카드 셀로 시딩(스트림 시작 전 scroll 1회),
        # 이후 place 이벤트마다 갱신. place_hint 셀이 기존 카드로 점유돼 있으면
        # nearest_free_cell이 곁 빈 셀로 스냅한다.
        local_occupied: set[str] = build_occupied(session_cards)

        def _next_place_event() -> dict:
            """다음 @concept의 좌표를 계산하고 스트림 상태를 갱신한다.

            계약(프론트와 공유): concept_index는 "이 답변(노드) 내 0-based
            로컬 인덱스"다 — attachments.canvas.concepts의 `i`와 동일한 의미
            (concept_blocks.parse의 index와도 일치, done 훅에서 대조).
              - index 0 → place_hint 셀(점유면 곁 빈 셀로 스냅)
              - index k≥1 → index 0 좌표를 앵커로 빈 셀
            """
            nonlocal concept_count
            idx = concept_count
            concept_count += 1
            if idx == 0 or 0 not in placed_coords:
                anchor = hint_anchor
            else:
                anchor = xy_to_cell(*placed_coords[0])
            col, row = nearest_free_cell(anchor, local_occupied)
            local_occupied.add(f"{col},{row}")
            x, y = cell_to_xy(col, row)
            placed_coords[idx] = (x, y)
            return {"concept_index": idx, "x": x, "y": y}

        # 라인 버퍼 (스트리밍 중 @concept: 감지용)
        line_buf = ""

        try:
            try:
                async for delta in exaone.stream_answer(
                    history,
                    body.question,
                    system_prompt,
                ):
                    answer_parts.append(delta)
                    yield _sse("token", {"delta": delta})

                    # 라인 버퍼에 토큰을 추가하고, 개행마다 @concept: 감지
                    for ch in delta:
                        if ch == "\n":
                            line = line_buf.rstrip()
                            line_buf = ""
                            if _CONCEPT_LINE_RE.match(line):
                                yield _sse("place", _next_place_event())
                        else:
                            line_buf += ch

                # 스트림 종료 flush: 개행 없이 끝난 마지막 라인이 @concept:면
                # place 1회 방출 — done 훅의 전체 재파싱 인덱스와 어긋나지 않도록.
                if _CONCEPT_LINE_RE.match(line_buf.rstrip()):
                    line_buf = ""
                    yield _sse("place", _next_place_event())

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
                # /art/search. Navigator generation is likewise dropped.
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
                            "tags": [],
                            "reference_sources": comparison_sources or [],
                        },
                        "current_head_id": node["id"],
                        "root_node_id": existing_root or node["id"],
                    },
                )

                # done 훅: canvas_cards 저장 + attachments 병합 (fire-and-forget)
                # retrieved(ebs/art)도 함께 전달해 단일 writer PATCH로 저장.
                if placed_coords:
                    asyncio.create_task(
                        _save_canvas_cards(
                            client,
                            user_id=user.id,
                            session_id=body.session_id,
                            node_id=node["id"],
                            answer=answer,
                            placed_coords=placed_coords,
                            retrieved=body.retrieved,
                        )
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
