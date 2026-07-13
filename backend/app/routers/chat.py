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
  event: place   data: {"concept_index": int, "x": float, "y": float,
                        "is_final": bool}
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

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..services import exaone, gemini, memory, rag
from ..services import sessions as svc
from ..services import concept_blocks, qdrant_store, upstage
from ..services.canvas_layout import (
    ExistingCard,
    estimate_card_height,
    place_new_card,
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
    """프론트가 /retrieve near를 릴레이하는 초기 배치 힌트.

    좌표는 힘 솔버가 계산한 연속 실수(float) — int로 두면 소수점 좌표에서 422가
    난다. 솔버가 벡터 유사도로 배치하므로 이 값은 현재 참조하지 않지만(프론트
    구계약 호환), 검증 실패로 요청을 막지 않도록 float로 수용한다.
    """

    x: float
    y: float


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


def _cosine(a: list[float], b: list[float]) -> float:
    """코사인 유사도[0,1] — 음수는 0으로 클램프(target_distance는 [0,1] 가정)."""
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5 or 1e-9
    nb = sum(x * x for x in b) ** 0.5 or 1e-9
    return max(0.0, dot / (na * nb))


def _place_for_new_concept(
    existing: list[ExistingCard], seed: int, new_h: float
) -> tuple[float, float]:
    """스트리밍/settle 공용 — 기존 카드에 대해 새 카드 좌표 1개 계산(연속 좌표)."""
    return place_new_card(new_h, existing, seed)


def _fill_missing_heights(
    placed_coords: dict[int, tuple[float, float]],
    placed_heights: dict[int, float],
) -> None:
    """settle 실패/부분 실패 보정 — 배치된 개념의 크기 기본값을 채운다(in-place).

    settle(parse/솔버)가 예외로 갱신하지 못한 index는 스트리밍 단계의 좌표
    (placed_coords, 이미 채워짐) + 기본 높이 estimate_card_height(2)로 저장되게 한다.
    이미 settle이 확정한 index는 건드리지 않는다(멱등).
    """
    for idx in placed_coords:
        placed_heights.setdefault(idx, estimate_card_height(2))


async def _scroll_session_cards(owner_id: str, session_id: str) -> list[dict]:
    """세션 기존 canvas_cards scroll(벡터 포함) — best-effort, 실패 시 [].

    스트림당 1회 호출해 스트리밍 place · done settle의 힘 솔버 pin
    목록(ExistingCard) 구성에 재사용한다(조회 중복 없음). 벡터를 포함해
    각 카드의 sim = _cosine(qvec, vec)을 산출한다.
    """
    try:
        return await qdrant_store.scroll_canvas_cards(
            owner_id=owner_id, session_id=session_id, with_vectors=True
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "canvas_cards scroll 실패 — 빈 pin 목록으로 진행 session=%s",
            session_id,
            exc_info=True,
        )
        return []


def _session_cards_as_existing(
    session_cards: list[dict], qvec: list[float]
) -> list[ExistingCard]:
    """세션 scroll 결과 → ExistingCard 목록(솔버 pin). sim = _cosine(qvec, vec).

    벡터/좌표가 없는 카드는 sim=0.0 · size_h 폴백(estimate_card_height(2))으로 채운다.
    이번 답변에서 배치 중인 개념은 포함하지 않는다(호출부에서 별도 pin).
    """
    out: list[ExistingCard] = []
    for c in session_cards:
        pl = c.get("payload") or {}
        vec = c.get("vector") or []
        sim = _cosine(qvec, vec) if (vec and qvec) else 0.0
        out.append(
            ExistingCard(
                x=float(pl.get("x", 0.0)),
                y=float(pl.get("y", 0.0)),
                h=float(pl.get("size_h") or estimate_card_height(2)),
                sim=sim,
            )
        )
    return out


def _existing_for_vec(
    session_cards: list[dict],
    placed: list[tuple[float, float, float, list[float]]],
    vec: list[float],
) -> list[ExistingCard]:
    """settle 위치 보정용 pin 목록 — 배치할 개념의 passage 벡터 `vec` 기준.

    각 기존 세션 카드 sim = cosine(vec, 카드 passage벡터); 같은 답변에서 이미 배치된
    개념 placed=[(x,y,h,pvec)]도 sim = cosine(vec, pvec)로 포함(고정 0.9 대신 대칭).
    벡터 없는 카드는 sim=0.0. 결정론(입력 순서 보존).
    """
    out: list[ExistingCard] = []
    for c in session_cards:
        pl = c.get("payload") or {}
        cvec = c.get("vector") or []
        sim = _cosine(vec, cvec) if (vec and cvec) else 0.0
        out.append(
            ExistingCard(
                x=float(pl.get("x", 0.0)),
                y=float(pl.get("y", 0.0)),
                h=float(pl.get("size_h") or estimate_card_height(2)),
                sim=sim,
            )
        )
    for (x, y, h, pvec) in placed:
        sim = _cosine(vec, pvec) if (vec and pvec) else 0.0
        out.append(ExistingCard(x=x, y=y, h=h, sim=sim))
    return out


async def _save_canvas_cards(
    client: UserClient,
    user_id: str,
    session_id: str,
    node_id: str,
    answer: str,
    placed_coords: dict[int, tuple[float, float]],
    placed_heights: dict[int, float],
    retrieved: RetrievedBody | None = None,
) -> None:
    """done 훅 — fire-and-forget: 개념 임베딩 + canvas_cards upsert + attachments 병합.

    done settle에서 확정한 최종 좌표(placed_coords) + 실제 카드 크기(placed_heights)를
    passage 벡터와 함께 canvas_cards에 저장한다(size_h·vector 포함).
    실패는 logger.warning만 — 스트림/답변 저장에 영향 없음.
    """
    try:
        blocks = concept_blocks.parse(answer)
        if not blocks:
            return

        # 개념 텍스트 목록 구성 (제목 + 본문) — passage 벡터 개념별 1배치
        texts = [f"{b['title']}\n{b['body']}" for b in blocks]

        # Upstage embedding-passage 배치 1회
        vectors = await upstage.embed_passages(texts)

        concepts_meta: list[dict] = []

        for b, vec in zip(blocks, vectors):
            # concept_blocks.parse의 index는 답변 내 0-based 로컬 인덱스 —
            # place SSE의 concept_index·concepts[].i와 같은 좌표계다.
            idx = b["index"]
            coord = placed_coords.get(idx)
            if coord is None:
                continue  # place 이벤트가 방출되지 않은 개념은 스킵
            x, y = coord
            h = placed_heights.get(idx) or estimate_card_height(2)
            await qdrant_store.upsert_canvas_card(
                owner_id=user_id,
                session_id=session_id,
                node_id=node_id,
                concept_index=idx,
                title=b["title"],
                x=x,
                y=y,
                size_h=h,
                vector=vec,
            )
            concepts_meta.append({"i": idx, "x": x, "y": y, "h": h})

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
    이 가정으로 좌표를 매칭한다. 각 항목은 {i, x, y, h} — h는 done settle에서
    확정한 카드 높이(size_h).
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
    # 질의 임베딩 1회 — (1) 교과서 RAG 검색과 (2) 기존 카드 코사인 유사도
    # (솔버 sim) 근거로 재사용한다(추가 임베딩 호출 없음). 실패해도 턴을
    # 죽이지 않는다: 빈 벡터 → 교과서 블록 생략 + sim 0.0 degraded 배치.
    try:
        qvec = await upstage.embed_query(body.question)
    except Exception:  # noqa: BLE001
        logger.warning(
            "질의 임베딩 실패 — 교과서 RAG 생략 + sim 0.0(degraded)로 배치 session=%s",
            body.session_id,
            exc_info=True,
        )
        qvec = []

    # All four context builders read the same ancestor chain but are otherwise
    # independent, and each is internally best-effort (own try/except, safe
    # defaults on failure). Run them concurrently to cut first-token latency —
    # the RAG builder's question-embedding Gemini call is the heaviest leg (D66).
    #   - reference:  imported other-branch context (node connections, LCA-trimmed, 3a, D35)
    #   - rag:        chunks from files linked to this branch (Stage 3b-2, D32 sources)
    #   - comparison: one-time branch references for THIS turn (D15/D46, LCA-trimmed)
    #   - textbook:   전역 교과서 코퍼스에서 질문과 유사한 청크 (거리 게이트)
    (
        (reference_context, reference_node_ids),
        rag_result,
        (comparison_context, comparison_node_ids, comparison_sources),
        textbook_result,
    ) = await asyncio.gather(
        memory.build_reference_context(client, body.session_id, chain, by_id),
        rag.build_rag_context(client, chain, body.question),
        memory.build_comparison_context(
            client, body.reference_node_ids or [], chain, by_id
        ),
        rag.build_textbook_context(qvec),
    )
    rag_context = rag_result["block"] if rag_result else None
    rag_sources = rag_result["sources"] if rag_result else []
    textbook_context = textbook_result["block"] if textbook_result else None
    textbook_sources = textbook_result["sources"] if textbook_result else []
    existing_root = session.get("root_node_id")

    # Turn log (D25) + structured prompt composition (D35). compose_system_structured
    # is the SINGLE source of truth for both the system prompt string AND each
    # block's char span, so the saved prompt and the admin highlight never drift.
    system_prompt, context_blocks_list = gemini.compose_system_structured(
        reference_context,
        rag_context,
        comparison_context,
        textbook_context=textbook_context,
        rag_sources=rag_sources,
        textbook_sources=textbook_sources,
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

    # 스트림 시작 전 1회 scroll(벡터 포함): 스트리밍 place · done settle의 힘
    # 솔버 pin 목록(ExistingCard) 구성에 재사용.
    session_cards = await _scroll_session_cards(user.id, body.session_id)

    async def event_stream():
        yield _sse(
            "start",
            {"session_id": body.session_id, "parent_node_id": parent_id},
        )
        answer_parts: list[str] = []

        # place 이벤트 계산용 스트림-스코프 상태
        # placed_coords: {concept_index: (x, y)} — done settle에서 최종값 갱신 후 훅에서 재사용
        # placed_heights: {concept_index: h} — done settle에서 실제 카드 크기 확정
        placed_coords: dict[int, tuple[float, float]] = {}
        placed_heights: dict[int, float] = {}
        concept_count = 0
        # 세션 기존 카드(이번 답변 제외) pin — 스트림 시작 전 scroll 1회로 확정.
        _session_pins = _session_cards_as_existing(session_cards, qvec)
        # 이번 답변 내 이미 배치한 개념 pin — 같은 답변이라 sim 근사(0.9).
        _pinned: list[ExistingCard] = []

        def _existing_cards() -> list[ExistingCard]:
            """솔버 pin 목록 — 세션 기존 카드 + 이번 답변 내 이미 배치한 개념."""
            return _session_pins + _pinned

        def _next_place_event() -> dict:
            """다음 @concept의 좌표를 힘 솔버로 계산하고 스트림 상태를 갱신한다.

            계약(프론트와 공유): concept_index는 "이 답변(노드) 내 0-based
            로컬 인덱스"다 — attachments.canvas.concepts의 `i`와 동일한 의미
            (concept_blocks.parse의 index와도 일치, done 훅에서 대조).
            스트리밍 중엔 본문 길이를 모르므로 estimate_card_height(2) 기본 크기로
            배치하고, done settle에서 실제 크기로 최종 안착(is_final=true)한다.
            """
            nonlocal concept_count
            idx = concept_count
            concept_count += 1
            base_h = estimate_card_height(2)
            existing = _existing_cards()
            x, y = _place_for_new_concept(existing, seed=len(existing), new_h=base_h)
            placed_coords[idx] = (x, y)
            # 방금 배치한 개념을 이후 개념의 pin 대상에 추가(같은 답변 내 분리).
            _pinned.append(ExistingCard(x=x, y=y, h=base_h, sim=0.9))
            return {"concept_index": idx, "x": x, "y": y, "is_final": False}

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

                # done settle — 실제 본문 길이로 카드 크기 확정 후 개념별 최종
                # 좌표를 힘 솔버로 재계산해 place{is_final:true}로 재전송한다.
                # 세션 기존 카드(이번 답변 제외)만 pin으로 두고, 답변 내 개념은
                # 확정 순서대로 하나씩 pin에 합류시켜 서로 겹치지 않게 한다.
                # concept_blocks.parse의 index = place SSE의 concept_index(0-based 로컬).
                #
                # 자체 격리: settle(parse/솔버)가 실패해도 스트림/저장은 무영향이어야
                # 한다 — 예외는 warning만, error SSE 방출 금지, 아래 canvas_cards
                # 저장(create_task)은 항상 도달한다. 실패 시 좌표는 스트리밍 단계의
                # placed_coords로 폴백(이미 채워짐), placed_heights는 기본값으로 보정.
                try:
                    parsed = concept_blocks.parse(answer)
                    existing_final = _session_cards_as_existing(session_cards, qvec)
                    for block in parsed:
                        body_text = block["body"]
                        lines = body_text.count("\n") + 1 if body_text else 0
                        h = estimate_card_height(lines)
                        # count_seed = 누적 카드 수(황금각 방향 결정) — block["index"]를
                        # 쓰면 단일 개념 답변마다 0이 되어 오프셋이 항상 (1,0)→모든
                        # 카드가 같은 y에 수평 정렬되는 1차원 퇴화가 발생한다.
                        # 스트리밍 경로(_place_for_new_concept, len(existing))와 동일 계약.
                        x, y = place_new_card(h, existing_final, len(existing_final))
                        placed_coords[block["index"]] = (x, y)
                        placed_heights[block["index"]] = h
                        existing_final.append(ExistingCard(x=x, y=y, h=h, sim=0.9))
                        yield _sse(
                            "place",
                            {
                                "concept_index": block["index"],
                                "x": x,
                                "y": y,
                                "is_final": True,
                            },
                        )
                except Exception:  # noqa: BLE001 - settle 실패 = 스트림/저장 무영향
                    logger.warning(
                        "done settle 실패 node=%s — 스트리밍 좌표로 폴백 저장",
                        node["id"],
                        exc_info=True,
                    )

                # settle 실패/부분 실패 대비 — 배치된 개념의 크기 기본값 보정.
                _fill_missing_heights(placed_coords, placed_heights)

                # done 훅: canvas_cards 저장 + attachments 병합 (fire-and-forget)
                # settle에서 확정한 최종 좌표(placed_coords)+크기(placed_heights)를
                # passage 벡터와 함께 저장. retrieved(ebs/art)도 단일 writer PATCH로 통합.
                if placed_coords:
                    asyncio.create_task(
                        _save_canvas_cards(
                            client,
                            user_id=user.id,
                            session_id=body.session_id,
                            node_id=node["id"],
                            answer=answer,
                            placed_coords=placed_coords,
                            placed_heights=placed_heights,
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
