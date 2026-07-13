import math

import pytest

from app.routers import chat as C
from app.routers.chat import (
    ChatStreamBody,
    _fill_missing_heights,
    _place_for_new_concept,
)
from app.services.canvas_layout import ExistingCard, estimate_card_height


def test_place_for_new_concept_returns_continuous_coords():
    existing = [ExistingCard(x=1300, y=800, h=200, sim=0.95)]
    x, y = _place_for_new_concept(existing, seed=1, new_h=estimate_card_height(2))
    assert isinstance(x, float) and isinstance(y, float)
    # 유사 카드 곁(겹치지 않음)
    d = math.hypot(x - 1300, y - 800)
    assert d > 0


def test_place_for_new_concept_empty_existing_is_center():
    from app.services.canvas_layout import CANVAS_W, CANVAS_H

    x, y = _place_for_new_concept([], seed=0, new_h=estimate_card_height(2))
    assert x == CANVAS_W / 2.0
    assert y == CANVAS_H / 2.0


def test_fill_missing_heights_fills_default_and_is_idempotent():
    # settle이 갱신한 index(1)는 보존, 미갱신 index(0,2)는 기본 높이로 보정.
    placed_coords = {0: (10.0, 20.0), 1: (30.0, 40.0), 2: (50.0, 60.0)}
    placed_heights = {1: 999.0}
    _fill_missing_heights(placed_coords, placed_heights)
    assert placed_heights[1] == 999.0  # 확정값 보존(멱등)
    assert placed_heights[0] == estimate_card_height(2)
    assert placed_heights[2] == estimate_card_height(2)


# ---------------------------------------------------------------------------
# settle 격리(Important 수정) — settle이 예외를 던져도:
#   (1) error SSE를 방출하지 않고,
#   (2) canvas_cards 저장(create_task) 경로에 도달하며,
#   (3) 스트리밍 단계 placed_coords로 폴백해 저장한다.
# chat_stream generator를 최소 목으로 구동해 검증(과하지 않게).
# ---------------------------------------------------------------------------


class _FakeUser:
    id = "u1"
    email = "u@test"


class _FakeClient:
    async def update(self, *a, **k):
        return None

    async def select(self, *a, **k):
        return []


async def _fake_stream_answer(history, question, system_prompt):
    # @concept 두 개 — 스트리밍 place 두 번(placed_coords 채움).
    for line in (
        "@concept: 첫째\n",
        "- 본문1\n",
        "@end\n",
        "@concept: 둘째\n",
        "- 본문2\n",
        "@end\n",
    ):
        yield line


async def _consume(
    monkeypatch, *, settle_raises: bool, textbook_result=None, spy: dict | None = None
):
    """chat_stream을 최소 목으로 구동해 방출 SSE 이벤트 목록을 반환."""
    import asyncio

    monkeypatch.setattr(C.UserClient, "from_user", classmethod(lambda cls, u: _FakeClient()))

    async def fake_get_session(client, sid):
        return {"owner_id": "u1", "current_head_id": None, "root_node_id": None}

    async def fake_get_nodes(client, sid):
        return []

    monkeypatch.setattr(C.svc, "get_session", fake_get_session)
    monkeypatch.setattr(C.svc, "get_session_nodes", fake_get_nodes)
    monkeypatch.setattr(C.svc, "ancestor_chain_nodes", lambda nodes, pid: [])

    async def fake_reference(*a, **k):
        return (None, [])

    async def fake_rag(*a, **k):
        return None

    async def fake_comparison(*a, **k):
        return (None, [], [])

    monkeypatch.setattr(C.memory, "build_reference_context", fake_reference)
    monkeypatch.setattr(C.rag, "build_rag_context", fake_rag)
    monkeypatch.setattr(C.memory, "build_comparison_context", fake_comparison)

    async def fake_textbook(qv):
        if spy is not None:
            spy["textbook_qvec"] = qv
        return textbook_result

    monkeypatch.setattr(C.rag, "build_textbook_context", fake_textbook)

    def fake_compose(*a, **k):
        if spy is not None:
            spy["compose_kwargs"] = k
        return ("sys", [])

    monkeypatch.setattr(C.gemini, "compose_system_structured", fake_compose)
    monkeypatch.setattr(C.exaone, "CONCEPT_CARD_SYSTEM_PROMPT", "base", raising=False)
    monkeypatch.setattr(C.exaone, "stream_answer", _fake_stream_answer)

    async def fake_scroll(owner_id, session_id, *, with_vectors=False):
        return []

    monkeypatch.setattr(C.qdrant_store, "scroll_canvas_cards", fake_scroll)

    async def fake_embed_query(q):
        return [0.1] * 10

    monkeypatch.setattr(C.upstage, "embed_query", fake_embed_query)

    async def fake_append_node(client, sid, pid, q, a, label):
        return {"id": "node-1", "parent_id": None}

    monkeypatch.setattr(C.svc, "append_node", fake_append_node)

    class _FakeTurnLog:
        def __init__(self, *a, **k):
            pass

        def set_system(self, *a, **k):
            pass

        def set_contexts_structured(self, *a, **k):
            pass

        def set_final(self, *a, **k):
            pass

        def add_error(self, *a, **k):
            pass

        async def save(self, *a, **k):
            pass

    monkeypatch.setattr(C, "TurnLog", _FakeTurnLog)

    if settle_raises:
        def boom(answer):
            raise RuntimeError("parse boom")

        monkeypatch.setattr(C.concept_blocks, "parse", boom)

    # done 훅(create_task)이 실제로 스케줄됐는지 추적 — 실행은 하지 않음.
    scheduled = []
    real_create_task = asyncio.create_task

    def spy_create_task(coro, *a, **k):
        scheduled.append(coro)
        coro.close()  # 코루틴 미실행 경고 방지(스케줄 여부만 확인)

        async def _noop():
            return None

        return real_create_task(_noop())

    monkeypatch.setattr(C.asyncio, "create_task", spy_create_task)

    body = ChatStreamBody(session_id="s1", question="질문")
    resp = await C.chat_stream(body, user=_FakeUser())
    events = []
    async for chunk in resp.body_iterator:
        events.append(chunk)
    return events, scheduled


def _event_names(events):
    names = []
    for e in events:
        first = e.split("\n", 1)[0]
        if first.startswith("event: "):
            names.append(first[len("event: "):])
    return names


@pytest.mark.asyncio
async def test_settle_success_emits_final_places_and_saves(monkeypatch):
    events, scheduled = await _consume(monkeypatch, settle_raises=False)
    names = _event_names(events)
    assert "error" not in names
    assert "done" in names
    # 스트리밍 place(is_final:false) + settle place(is_final:true) 모두 존재.
    assert any('"is_final": true' in e for e in events)
    assert any('"is_final": false' in e for e in events)
    assert len(scheduled) == 1  # canvas_cards 저장 스케줄됨.


@pytest.mark.asyncio
async def test_settle_failure_is_isolated(monkeypatch):
    # concept_blocks.parse가 raise → settle 실패. 그래도:
    events, scheduled = await _consume(monkeypatch, settle_raises=True)
    names = _event_names(events)
    assert "error" not in names          # (1) error SSE 미방출
    assert "done" in names               # done은 정상 방출됨
    assert len(scheduled) == 1           # (2) canvas_cards 저장 경로 도달(폴백)


@pytest.mark.asyncio
async def test_textbook_context_wired_qvec_reused_and_composed(monkeypatch):
    """교과서 RAG 배선: 캔버스용 질문 임베딩(qvec)이 재사용되고,
    결과 block/sources가 compose_system_structured에 전달된다."""
    spy = {}
    tb = {
        "block": "[교과서에서 참고]\n- [중학 과학 2 · p.12] 광합성",
        "sources": [{"name": "중학 과학 2", "page": 12}],
    }
    events, _ = await _consume(
        monkeypatch, settle_raises=False, textbook_result=tb, spy=spy
    )
    # qvec 재사용 — fake_embed_query가 준 벡터가 그대로 전달됨
    assert spy["textbook_qvec"] == [0.1] * 10
    assert spy["compose_kwargs"]["textbook_context"] == tb["block"]
    assert spy["compose_kwargs"]["textbook_sources"] == tb["sources"]
    assert "done" in _event_names(events)


@pytest.mark.asyncio
async def test_textbook_none_composes_without_block(monkeypatch):
    spy = {}
    await _consume(monkeypatch, settle_raises=False, textbook_result=None, spy=spy)
    assert spy["compose_kwargs"]["textbook_context"] is None
    assert spy["compose_kwargs"]["textbook_sources"] == []
