"""Chat (SSE) — concept-card conversation core (Upstage solar, D108).

Flow:
  1. Resolve parent (body.parent_node_id or session.current_head_id).
  2. Assemble ancestor-chain context (siblings excluded).
  3. Stream the model answer as SSE: start -> token* -> done (error on failure).
     The answer is the structured concept-card format (CHAT:/@concept/…/@end);
     the frontend parser turns the token stream into cards. Card layout + camera
     are owned by the frontend (d3-force) — the server no longer computes/sends
     positions.
  4. Persist (question, structured-answer) = 1 node with a NULL label, advance
     head (set root if first), and report the node in the `done` event.
  5. After done: a fire-and-forget task patches nodes.attachments.canvas with the
     figure search results only (best-effort, log only on failure). No card
     coordinates, embedding, or canvas_cards.

SSE event schema:
  event: start   data: {"session_id","parent_node_id"}
  event: token   data: {"delta"}
  event: done    data: {"node":{"id","parent_id","label":null,
                        "rag_sources":[...]},
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

from .. import ai
from ..auth.deps import CurrentUser, get_current_user
from ..config import get_settings
from ..db.client import UserClient
from ..services import (
    app_settings,
    figure_search,
    gemini,
    rag,
    session_context,
    solar,
)
from ..services import sessions as svc
from ..services.turn_log import TurnLog

logger = logging.getLogger("nodi.chat")
router = APIRouter(prefix="/chat", tags=["chat"])
settings = get_settings()

QUESTION_MAX_CHARS = 8000


class RetrievedFigureItem(BaseModel):
    """프론트가 /retrieve에서 받은 교과서 figure 항목.

    D87: **url 필드 없음** — signed URL은 만료되므로 영속하지 않는다(만료 URL
    화석화 방지). 재수화는 figure_id로 GET /files/figures/{id}에서 재발급한다.
    프론트가 url을 실어 보내도 extra 무시(기본 모델 설정)로 저장되지 않는다.
    """
    figure_id: str
    file_id: str
    page: int | None = None
    caption: str = ""
    score: float


class RetrievedBody(BaseModel):
    """done 훅에서 attachments.canvas에 통합 저장할 figures 검색 결과.

    D94: EBS·아트 제거 — 프론트 구버전이 ebs/art 키를 실어 보내도 extra 무시
    (기본 모델 설정)로 버려진다.
    """
    figures: list[RetrievedFigureItem] = Field(default_factory=list)


class ChatStreamBody(BaseModel):
    session_id: str
    question: str = Field(min_length=1, max_length=QUESTION_MAX_CHARS)
    parent_node_id: str | None = None
    # 09 단일 writer: 프론트 retrieve 결과(figures)를 서버에 전달해 done 훅이
    # attachments.canvas에 저장. null이면 저장하지 않음(첫 질문 전 degraded
    # 케이스 등). 카드 좌표는 프론트 소유 — 서버는 저장하지 않음.
    retrieved: RetrievedBody | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _patch_canvas_unified(
    client: UserClient, node_id: str, retrieved: RetrievedBody | None = None,
) -> None:
    """nodes.attachments.canvas에 figures만 저장(카드 좌표는 프론트 소유 — 저장 안 함).

    D87: figures는 figure_id/file_id 등 재수화 가능한 식별자만 저장하고 signed URL은
    실지 않는다(RetrievedFigureItem에 url 필드 없음). retrieved가 있으면 키를 항상
    기록(빈 리스트여도 키 유지). D94: 구 노드의 ebs/art 키는 canvas 통째 교체로
    자연 소멸(프론트도 더 읽지 않음)."""
    if retrieved is None:
        return
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
        attachments["canvas"] = {
            "figures": [f.model_dump() for f in retrieved.figures],
        }
        await client.update("nodes", {"id": f"eq.{node_id}"}, {"attachments": attachments})
    except Exception:  # noqa: BLE001
        logger.warning("attachments.canvas(figures) 저장 실패 node=%s", node_id, exc_info=True)


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
    history = [(n.get("question") or "", n.get("answer") or "") for n in chain]
    # 두 컨텍스트 빌더는 서로 독립이고 각자 best-effort(자체 try/except, 실패 시
    # 안전 기본값)다. 동시에 돌려 첫 토큰 지연을 줄인다 — RAG의 질의 임베딩이
    # 가장 무거운 레그다(D66).
    #   - rag:           이 학급 세션의 class_material 청크 자동 스코프 (D73/D82)
    #   - session_files: 세션에 올린 학생 파일 전문, 임베딩 없음 (D83)
    #
    # D107: 기억 연결(memory_link)·비교 참조(comparison) 레그는 제거됐다 —
    # 캔버스 UI에 그 둘을 만드는 경로가 없어 언제나 빈 결과였다.
    #
    # D109: ReAct가 켜지면 **컨텍스트 선주입을 전부 걷어낸다.** 자료 검색·파일
    # 전문·태그 목록은 각각 스킬이 되어 필요할 때만 돈다. 예전에는 인사 한
    # 마디에도 질의 임베딩 + Qdrant 검색 + 최대 15만 자 주입이 나갔다.
    overlay = await app_settings.get_overlay()
    react_on = app_settings.as_bool(overlay, "react_enabled", settings.react_enabled)
    react_steps = app_settings.as_int(
        overlay, "react_max_steps", settings.react_max_steps, 1, 8
    )

    react_role = "student"
    react_has_files = False
    legacy_figures: list[dict] = []
    if react_on:
        rag_result = None
        session_file_result = None
        # 카탈로그가 역할·세션 상태로 갈리므로 두 가지를 미리 확인한다. 둘 다
        # 인덱스 조회 한 번이고, ReAct가 꺼져 있으면 아예 돌지 않는다.
        try:
            rows = await client.select(
                "profiles",
                {"id": f"eq.{user.id}", "select": "role", "limit": "1"},
            )
            if rows:
                react_role = rows[0].get("role") or "student"
        except Exception:  # noqa: BLE001 - 역할 조회 실패는 학생으로 강등
            logger.warning("역할 조회 실패 — student 카탈로그로 진행", exc_info=True)
        try:
            # 파일이 없는데 파일 스킬을 노출하면, 모델이 부르고 빈 목록을 받고
            # "올리신 파일이 없네요" 같은 군더더기를 답에 붙인다.
            frows = await client.select(
                "files",
                {
                    "session_id": f"eq.{body.session_id}",
                    "kind": "eq.user_upload",
                    "status": "eq.indexed",
                    "select": "id",
                    "limit": "1",
                },
            )
            react_has_files = bool(frows)
        except Exception:  # noqa: BLE001 - 확인 실패는 "없음"으로 강등
            logger.warning("세션 파일 확인 실패 — 파일 스킬 미노출", exc_info=True)
    else:
        # D111: 도판 검색도 여기서 한다. 예전에는 **프론트가** SSE 전에
        # /retrieve를 따로 불렀는데, 그러면 검색 오케스트레이션이 클라이언트에
        # 남고 ReAct 경로와 중복된다(학급 세션에서 두 번 검색됐다).
        rag_result, session_file_result, legacy_figures = await asyncio.gather(
            rag.build_rag_context(
                client,
                body.question,
                # D73/D82: 학급 세션이면 class_material 자동 스코프 — 세션 행에 이미
                # space_kind/space_ref가 있어 추가 조회 없음(SESSION_SELECT).
                space_kind=session.get("space_kind"),
                space_ref=session.get("space_ref"),
            ),
            session_context.build_session_file_context(client, body.session_id),
            figure_search.search_class_figures(
                client,
                session.get("space_ref") if session.get("space_kind") == "class" else None,
                body.question,
            ),
        )
    rag_context = rag_result["block"] if rag_result else None
    # ReAct 경로에서는 스킬이 찾아낸 출처가 나중에 채운다.
    rag_sources = rag_result["sources"] if rag_result else []
    session_file_block = session_file_result["block"] if session_file_result else None
    session_file_sources = session_file_result["files"] if session_file_result else []
    existing_root = session.get("root_node_id")

    # D89: 이 세션에서 이미 쓰인 분류 태그를 tag_guide 블록으로 주입해 같은 주제
    # 새 개념이 기존 태그를 재사용하게 한다. 이미 로드된 nodes(created_at.asc)를
    # 재사용 — 추가 DB 조회 없음. 순수 함수라 예외 여지가 거의 없지만 컨텍스트
    # 빌더 best-effort 불변식에 맞춰 방어적으로 None 폴백.
    # D109: ReAct에서는 `list_session_concepts` 스킬이 이 일을 대신한다 —
    # 첫 질문이나 분류가 자명한 턴에는 아예 조회하지 않는다.
    tag_context = None
    if not react_on:
        try:
            used_tags = solar.extract_used_tags(nodes)
            tag_context = ", ".join(used_tags) if used_tags else None
        except Exception:
            tag_context = None

    # Turn log (D25) + structured prompt composition (D35). compose_system_structured
    # is the SINGLE source of truth for both the system prompt string AND each
    # block's char span, so the saved prompt and the admin highlight never drift.
    system_prompt, context_blocks_list = gemini.compose_system_structured(
        rag_context,
        session_file_context=session_file_block,
        session_file_sources=session_file_sources,
        tag_context=tag_context,
        rag_sources=rag_sources,
        base_instruction=solar.CONCEPT_CARD_SYSTEM_PROMPT,
    )
    tlog = TurnLog(user.id, body.session_id, body.question)
    tlog.set_system(system_prompt)
    tlog.set_contexts_structured(
        blocks=context_blocks_list,
        history_turns=len(history),
        history_chars=sum(len(q) + len(a) for q, a in history),
    )

    async def event_stream():
        nonlocal rag_sources
        yield _sse(
            "start",
            {"session_id": body.session_id, "parent_node_id": parent_id},
        )
        answer_parts: list[str] = []
        # ReAct는 스킬이, 레거시는 위 gather가 채운다 — 이후 경로는 동일하다.
        skill_figures: list[dict] = list(legacy_figures)

        try:
            try:
                if react_on:
                    # D109: 도구 판단 → 스킬 → 생성. 중간 단계는 tool_call /
                    # tool_result SSE로 흘러 프론트가 "자료 찾는 중"을 띄운다.
                    ctx = ai.SkillContext(
                        user_id=user.id,
                        client=client,
                        session_id=body.session_id,
                        space_kind=session.get("space_kind") or "personal",
                        space_ref=session.get("space_ref"),
                        role=react_role,
                    )
                    tool_names = ai.skills_for(
                        ctx.space_kind,
                        ctx.role,
                        has_session_files=react_has_files,
                        # 이미 읽어 둔 세션 노드로 판단 — 추가 조회 없음.
                        has_concepts=bool(nodes),
                    )
                    async for kind, payload in ai.get_orchestrator().run(
                        ctx=ctx,
                        question=body.question,
                        history=history,
                        tool_names=tool_names,
                        answer_system_prompt=system_prompt,
                        max_steps=react_steps,
                    ):
                        if kind == "sse":
                            yield payload
                        elif kind == "token":
                            answer_parts.append(payload)
                            yield _sse("token", {"delta": payload})
                        elif kind == "outcome":
                            # 스킬이 찾아온 출처·도판을 아래 영속 경로가 쓴다.
                            rag_sources = payload.rag_sources
                            skill_figures = payload.figures
                else:
                    async for delta in solar.stream_answer(
                        history,
                        body.question,
                        system_prompt,
                    ):
                        answer_parts.append(delta)
                        yield _sse("token", {"delta": delta})

            except Exception:  # noqa: BLE001 - details go to logs, not the client
                logger.exception("채팅 스트리밍 실패")
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
                # The frontend parses the answer text into concept cards.
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
                            # D74: 실시간 출처 칩 표시용(영속은 위 PATCH가 담당).
                            "rag_sources": rag_sources or [],
                        },
                        "current_head_id": node["id"],
                        "root_node_id": existing_root or node["id"],
                        # D109: ReAct 경로에서는 도판을 스킬이 찾으므로 프론트가
                        # 선행 호출하지 않는다. done에 실어 캔버스가 바로 띄운다.
                        "figures": skill_figures,
                    },
                )

                # attachments.canvas 저장(figures만) — 카드 좌표는 프론트 소유.
                # 자체 격리: 저장이 실패해도 스트림/저장 완료된 턴은 무영향(warning만).
                retrieved = body.retrieved
                if skill_figures:
                    # ReAct 경로: 스킬 결과를 영속 형태로 변환(D87 — url 제외).
                    retrieved = RetrievedBody(
                        figures=[
                            RetrievedFigureItem(
                                figure_id=str(f["figure_id"]),
                                file_id=str(f["file_id"]),
                                page=f.get("page"),
                                caption=f.get("caption") or "",
                                score=float(f.get("score") or 0.0),
                            )
                            for f in skill_figures
                            if f.get("figure_id") and f.get("file_id")
                        ]
                    )
                if retrieved is not None:
                    asyncio.create_task(
                        _patch_canvas_unified(client, node["id"], retrieved)
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

