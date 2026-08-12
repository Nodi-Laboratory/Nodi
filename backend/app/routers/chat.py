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
    canvas_items,
    figure_search,
    gemini,
    ink_marks,
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


class InkContext(BaseModel):
    """펜으로 그린 표시의 해석 (D178). 손으로 물었을 때만 온다.

    **카드 본문은 받지 않는다** — id만 받고 서버가 RLS 경로로 다시 읽는다
    (`canvas_items.ink_cards_context`). 클라이언트가 보낸 본문을 프롬프트에
    그대로 넣는 것은 기존 신뢰 경계 규약(D104)과 결이 안 맞는다.

    `card_ids`의 **순서가 곧 `[카드 N]`의 N**이다. 그 번호는 비전 모델에 보낸
    도식 그림에 배지로 박혀 있고 `marks_note`도 그 번호를 쓴다 — 여기서 다시
    매기면 설명과 본문이 다른 카드를 가리킨다.
    """

    marks_note: str = Field(default="", max_length=2000)
    card_ids: list[str] = Field(default_factory=list, max_length=8)
    #: 기하가 센 **짚은 카드 번호**(1부터). 프롬프트에 우리 말로 못 박는다 —
    #: 비전 모델의 산문에서 SOLAR가 읽어 내기를 기대하면 자주 다른 카드를
    #: 설명한다(사용자 보고 2026-08-05).
    pointed: list[int] = Field(default_factory=list, max_length=8)


class ChatStreamBody(BaseModel):
    session_id: str
    question: str = Field(min_length=1, max_length=QUESTION_MAX_CHARS)
    parent_node_id: str | None = None
    # D151: 학생이 지금 고른 트리(분류 태그). **컨텍스트를 자르는 값이 아니다** —
    # 서버는 모든 카드를 태그별 트리 순서로 다 넣고, 이 값으로 "지금 여기를
    # 보고 있다"만 알린다(사용자 결정 2026-08-02).
    focus_tag: str | None = Field(default=None, max_length=200)
    # 09 단일 writer: 프론트 retrieve 결과(figures)를 서버에 전달해 done 훅이
    # attachments.canvas에 저장. null이면 저장하지 않음(첫 질문 전 degraded
    # 케이스 등). 카드 좌표는 프론트 소유 — 서버는 저장하지 않음.
    retrieved: RetrievedBody | None = None
    # D178: 학생이 펜으로 그린 표시. 없으면 None(자판으로 친 평범한 질문).
    ink: InkContext | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _patch_canvas_unified(
    client: UserClient,
    node_id: str,
    retrieved: RetrievedBody | None = None,
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


async def _has_row(client: UserClient, what: str, table: str, params: dict) -> bool:
    """행이 하나라도 있나. **실패는 "없음"으로 강등한다.**

    카탈로그를 좁히는 판단은 best-effort다 — 여기서 예외가 나가면 학생의 질문
    자체가 죽는다. 도구 하나를 못 보여 주는 것이 훨씬 싸다.
    """
    try:
        return bool(await client.select(table, params))
    except Exception:  # noqa: BLE001 - 위 docstring 참조
        logger.warning("%s 확인 실패 - 해당 스킬 미노출", what, exc_info=True)
        return False


#: 판단 단계 안내에 실을 개념 제목 수 상한. 넘치면 최근 것부터 남긴다 —
#: 못 실린 제목은 `get_concept`이 빗나갈 때 `available`로 돌려준다(회복 경로).
_HINT_TITLES = 40


def _concept_hint(titles: list[str]) -> str | None:
    """판단 단계에 넘길 "이 방에 뭐가 있나" 한 덩어리 (D216).

    도구가 아니라 **안내**인 이유는 D135와 같다 — 모델이 부를지 말지 정하는
    선택지로 두면 보장이 권유가 되고, 실제로 매번 왕복 하나를 더 쓴다.
    """
    seen: list[str] = []
    for t in titles:
        t = (t or "").strip()
        if t and t not in seen:
            seen.append(t)
    if not seen:
        return None
    return (
        "[이 학습 지도에 이미 있는 개념 카드]\n"
        + ", ".join(seen[-_HINT_TITLES:])
        + "\n학생이 '아까 그거'처럼 앞의 설명을 가리키면 위 제목으로"
        " get_concept을 부른다. 목록에 없으면 부르지 않는다."
    )


async def _react_probes(
    client: UserClient, user_id: str, session_id: str
) -> tuple[str, bool, bool, list[str]]:
    """카탈로그를 좁히는 네 가지를 **한꺼번에** 확인한다 (2026-08-09).

    `(역할, 세션 파일 있나, 학생 글 있나, 개념 카드 제목들)`.

    ## 왜 동시에 도나

    넷은 서로를 안 본다. 그런데 하나씩 `await`했더니 넷이 **줄을 섰다** —
    각각 풀에서 커넥션을 따로 얻고 트랜잭션을 열고 닫으므로(`user_conn`),
    첫 글자가 나오기 전에 그 왕복이 전부 쌓인다. 커넥션이 각자라 동시에 돌아도
    안전하다.

    ## 개념 카드는 `nodes`로 세지 않는다

    예전에는 `has_concepts=bool(nodes)`였다. `nodes`는 **턴이 있었나**이지
    카드가 있나가 아니다 — 인사 한 마디에도 노드가 생기고, 학생이 카드를 전부
    지워도 노드는 남는다. 그래서 카드가 0장인 방인데 2턴째부터 개념 스킬 둘이
    열리고, 둘이 열리니 `think`까지 딸려 나오고(도구 2개 이상이면 붙는다),
    카탈로그가 비지 않으니 **판단 단계가 통째로 돈다.**

    실측 2026-08-09(개인 방, 카드 0장, 인사만 세 번):
      1턴 1030ms -> 2턴 1770ms · 3턴 1730ms — 매 턴 **+720ms**가 헛돌았다.

    출처는 `canvas_items`다. D215가 `get_concept`에 대해 이미 내린 결론과 같다 —
    화면의 글이 정본이고 `nodes.answer`는 AI가 처음 쓴 글이다.

    ## 개념은 "있나"가 아니라 **제목까지** 읽는다

    같은 행을 읽으면서 제목을 함께 가져오면 판단 단계 안내(D216)가 공짜로
    나온다. `limit=1`로 존재만 확인하고 모델에게 목록을 다시 묻게 하면 왕복
    하나가 더 든다.
    """

    async def _titles() -> list[str]:
        try:
            rows = await client.select(
                "canvas_items",
                {
                    "session_id": f"eq.{session_id}",
                    "kind": "eq.concept",
                    "source": "eq.ai",
                    "select": "title",
                    "order": "seq.asc",
                    "limit": str(_HINT_TITLES),
                },
            )
            return [r.get("title") or "" for r in rows]
        except Exception:  # noqa: BLE001 - 확인 실패는 "없음"으로 강등
            logger.warning("개념 카드 확인 실패 - 개념 스킬 미노출", exc_info=True)
            return []

    async def _role() -> str:
        try:
            rows = await client.select(
                "profiles", {"id": f"eq.{user_id}", "select": "role", "limit": "1"}
            )
            return (rows[0].get("role") or "student") if rows else "student"
        except Exception:  # noqa: BLE001 - 역할 조회 실패는 학생으로 강등
            logger.warning("역할 조회 실패 - student 카탈로그로 진행", exc_info=True)
            return "student"

    role, has_files, has_notes, titles = await asyncio.gather(
        _role(),
        # 파일이 없는데 파일 스킬을 노출하면, 모델이 부르고 빈 목록을 받고
        # "올리신 파일이 없네요" 같은 군더더기를 답에 붙인다.
        _has_row(
            client,
            "세션 파일",
            "files",
            {
                "session_id": f"eq.{session_id}",
                "kind": "eq.user_upload",
                "status": "eq.indexed",
                "select": "id",
                "limit": "1",
            },
        ),
        # 학생이 캔버스에 직접 쓴 글. 파일과 **같은 이유**로 있을 때만 연다.
        _has_row(
            client,
            "학생 글",
            "canvas_items",
            {
                "session_id": f"eq.{session_id}",
                "kind": "eq.note",
                "select": "id",
                "limit": "1",
            },
        ),
        # AI 개념 카드. `source=ai`까지 봐야 한다 - 학생이 쓴 글은 위에서
        # 따로 센다.
        _titles(),
    )
    return role, has_files, has_notes, titles


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
    react_steps = app_settings.as_int(overlay, "react_max_steps", settings.react_max_steps, 1, 8)

    react_role = "student"
    react_has_files = False
    react_has_notes = False
    react_concepts: list[str] = []
    legacy_figures: list[dict] = []
    if react_on:
        rag_result = None
        session_file_result = None
        # 카탈로그가 역할·세션 상태로 갈린다. 넷을 한꺼번에 확인한다
        # (`_react_probes` docstring에 왜 동시인지, 왜 nodes가 아닌지 적었다).
        (
            react_role,
            react_has_files,
            react_has_notes,
            react_concepts,
        ) = await _react_probes(client, str(user.id), body.session_id)
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

    # D89/D135: 이 세션에서 이미 쓰인 분류 태그를 tag_guide 블록으로 **항상**
    # 주입한다. 같은 주제의 새 개념이 기존 태그를 글자 그대로 재사용해야
    # 캔버스에서 한 열로 묶인다.
    #
    # D109에서 ReAct로 옮기며 이 주입을 껐다 — `list_session_concepts` 스킬이
    # 대신한다고 봤기 때문이다. **그게 틀렸다.** 그 스킬은 모델이 부를지 말지
    # 정하는 선택지이고("분류가 자명하면 부르지 않아도 된다"), 실제로 거의
    # 부르지 않는다. 보장이 권유로 바뀌면서 태그가 매 턴 새로 만들어졌다.
    #
    # 실측(2026-07-31, 로컬 세션 2개):
    #   개념 18개 → 태그 10종, 열당 평균 1.5~1.8개
    #   "생명과학"/"생명과학 기초", "교육"/"교육 기술"처럼 같은 주제가 갈리고
    #   광합성 개념 셋이 서로 다른 세 열로 흩어졌다 — 묶기가 아예 작동하지 않았다.
    #
    # 태그 출처도 canvas_items로 옮긴다. nodes.answer 파싱은 **학생이 직접 바꾼
    # 분류를 못 본다**(D122로 태그의 소유자가 canvas_items가 됐다). 레거시 세션
    # (canvas_items가 비어 있음)만 옛 파서로 떨어진다.
    tag_context = None
    try:
        used_tags = await canvas_items.session_tags(client, body.session_id)
        if not used_tags:
            used_tags = solar.extract_used_tags(nodes)
        tag_context = ", ".join(used_tags) if used_tags else None
    except Exception:
        # 컨텍스트 빌더는 best-effort — 태그 안내가 없다고 턴을 죽이지 않는다.
        # **다만 조용히 넘기지는 않는다.** 이 기능이 처음 망가진 방식이 정확히
        # "실패가 아무 흔적도 남기지 않는 것"이었다(실제로 여기서 미지원 필터
        # 문법으로 예외가 났는데 로그가 없어 재사용이 되는 줄 알았다).
        logger.warning("태그 목록 조회 실패 — 이번 턴은 태그 안내 없이 간다", exc_info=True)
        tag_context = None

    # D151: 카드 전부를 **태그별 트리 순서**로 넣는다. 태그 목록(tag_guide)이
    # "무엇이 있나"라면 이건 "무엇에서 무엇이 나왔나"다. 학생이 고른 트리에는
    # 표시를 달아 그 맥락을 우선 보게 한다 — 자르는 것이 아니라 가리키는 것이다.
    tree_context = None
    try:
        tree_context = await canvas_items.session_tree_context(
            client, body.session_id, (body.focus_tag or "").strip() or None
        )
    except Exception:
        # 태그 안내와 같은 이유로 조용히 넘기지 않는다 — 실패가 흔적을 안 남기면
        # 기능이 꺼진 줄 모른다(D135 주석 참조).
        logger.warning("대화 트리 조회 실패 — 이번 턴은 트리 안내 없이 간다", exc_info=True)
        tree_context = None

    # D178: 펜으로 그린 표시 + 그 주변 카드. 표시 설명과 카드 본문을 한 블록에
    # 담는다 — 둘의 **[카드 N] 번호가 같아야** 모델이 짚은 것을 짚는다.
    ink_context = None
    if body.ink and (body.ink.card_ids or body.ink.marks_note.strip()):
        try:
            cards = await canvas_items.ink_cards_context(
                client,
                body.session_id,
                body.ink.card_ids,
                (await ink_marks.read_card_body_max()),
                body.ink.pointed,
            )
            cards_block = cards.block if cards else None
            note = body.ink.marks_note.strip()
            chunks = []
            # **결론이 맨 앞이다.** 뒤에 두면 카드 본문에 묻힌다. 이 값은 기하가
            # 센 것이지 모델이 고른 것이 아니다 — 그래서 단정해서 쓴다.
            if cards and cards.targets:
                chunks.append(
                    "학생이 표시로 짚은 카드: "
                    + ", ".join(cards.targets)
                    + "\n질문의 '이거'·'여기'는 **이 카드**를 뜻합니다. "
                    "다른 카드는 배경이니 묻지 않은 것을 설명하지 마세요."
                )
            if note:
                chunks.append(note)
            elif cards_block:
                # **표시를 못 읽었다는 사실을 숨기지 않는다.** 비전 모델이
                # 실패하면 note가 비는데, 그대로 카드만 넣으면 프롬프트 머리말
                # ("표시가 무엇을 가리키는지")이 거짓이 되고 모델은 없는 지시를
                # 찾는다. 화살표는 못 읽었어도 "이 카드들 근처에서 물었다"는
                # 여전히 참이다 — 그것만 말한다.
                chunks.append(
                    "표시가 무엇을 가리키는지는 읽지 못했습니다. "
                    "아래 카드들이 학생이 표시한 자리 주변에 있었습니다."
                )
            if cards_block:
                chunks.append("[표시 주변의 카드]\n" + cards_block)
            ink_context = "\n\n".join(chunks) or None
        except Exception:
            # 다른 빌더와 같은 이유로 조용히 넘기지 않는다 — 실패가 흔적을
            # 안 남기면 기능이 꺼진 줄 모른다(D135 주석 참조).
            logger.warning("펜 표시 맥락 조립 실패 — 표시 없이 간다", exc_info=True)
            ink_context = None

    # Turn log (D25) + structured prompt composition (D35). compose_system_structured
    # is the SINGLE source of truth for both the system prompt string AND each
    # block's char span, so the saved prompt and the admin highlight never drift.
    system_prompt, context_blocks_list = gemini.compose_system_structured(
        rag_context,
        session_file_context=session_file_block,
        session_file_sources=session_file_sources,
        tag_context=tag_context,
        tree_context=tree_context,
        ink_context=ink_context,
        rag_sources=rag_sources,
        base_instruction=solar.CONCEPT_CARD_SYSTEM_PROMPT,
        # 앞의 블록들이 형식 지시를 밀어낸다 — 꼬리에서 한 번 더 못 박는다.
        format_reminder=solar.FORMAT_REMINDER,
    )
    tlog = TurnLog(user.id, body.session_id, body.question)
    # D113: 어느 경로로 돌았는지·어떤 모델이었는지를 로그만 보고 알 수 있어야
    # 한다. react_enabled를 나중에 바꾸면 과거 로그의 해석이 달라지기 때문이다.
    tlog.set_route("react" if react_on else "legacy", settings.upstage_chat_model)
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
        # D149: 강의 클립 — 오케스트레이터가 모아 done 이벤트로만 실어 보낸다
        # (canvas_items 클라이언트 영속에 의존, 서버 attachments 영속 안 함).
        skill_clips: list[dict] = []

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
                        has_concepts=bool(react_concepts),
                        has_notes=react_has_notes,
                    )
                    async for kind, payload in ai.get_orchestrator().run(
                        ctx=ctx,
                        question=body.question,
                        history=history,
                        tool_names=tool_names,
                        answer_system_prompt=system_prompt,
                        # 히스토리에 봉투를 씌울 때 쓸 분류 (D197). 지금 보고
                        # 있는 트리가 가장 그럴듯하고, 없으면 이 세션에서 가장
                        # 먼저 쓰인 분류를 쓴다.
                        tag_hint=(body.focus_tag or "").strip()
                        or (used_tags[0] if used_tags else None),
                        # D216: 판단 단계는 캔버스를 못 본다 — 제목을 넘겨야
                        # "아까 그거"에 목록 왕복 없이 답한다.
                        concept_hint=_concept_hint(react_concepts),
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
                            # D149: 스킬이 모은 강의 클립을 done으로 흘린다.
                            skill_clips = payload.clips
                            # D112: 근거 블록이 붙은 **실제 전송 프롬프트**로
                            # 덮어쓴다. 안 하면 admin 로그가 실제와 달라진다
                            # (D35의 "저장한 프롬프트 = 실제" 계약).
                            if payload.final_system:
                                tlog.set_system(payload.final_system)
                            # D113: 스킬 트레이스·실측 토큰을 로그로.
                            tlog.set_skill_traces(payload.skill_traces)
                            tlog.add_llm_calls(payload.llm_calls)
                else:
                    answer_usage: dict[str, int] = {}
                    async for delta in solar.stream_answer(
                        history,
                        body.question,
                        system_prompt,
                        usage_sink=answer_usage,
                        tag_hint=(body.focus_tag or "").strip()
                        or (used_tags[0] if used_tags else None),
                    ):
                        answer_parts.append(delta)
                        yield _sse("token", {"delta": delta})
                    if answer_usage:
                        tlog.add_llm_calls([{"stage": "answer", **answer_usage}])

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

            # 형식을 어긴 답을 **셀 수 있게** 남긴다 (D197).
            #
            # 모델은 `@concept:` 봉투를 심심찮게 빠뜨린다(실측 2026-08-07: 18턴
            # 중 4~6턴). 프론트가 되살려 주므로 학생 화면은 멀쩡하지만, 그래서
            # **아무도 모른 채 나빠질 수 있다.** 되살리기는 그물이고 이 로그는
            # 계기판이다 — 비율이 오르면 프롬프트나 모델을 손봐야 한다는 신호다.
            if "@concept:" not in answer:
                logger.warning(
                    "개념 카드 형식 누락 session=%s len=%d — 프론트 되살리기에 기댄다",
                    body.session_id,
                    len(answer),
                )
                tlog.add_error("missing_concept_envelope")

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
                        await client.update("nodes", {"id": f"eq.{node['id']}"}, provenance)
                    except Exception:  # noqa: BLE001
                        logger.warning("provenance persist failed node=%s", node["id"])

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
                        # D149: 강의 클립 — 캔버스가 카드로 띄운다.
                        "clips": skill_clips,
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
                    asyncio.create_task(_patch_canvas_unified(client, node["id"], retrieved))

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
