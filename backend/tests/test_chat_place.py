import pytest

from app.routers import chat as C
from app.routers.chat import ChatStreamBody, RetrievedBody

# ---------------------------------------------------------------------------
# 카드 배치·좌표는 프론트 소유(d3-force) — 서버는 place/settle을 계산·전송하지 않는다.
# 여기선 done-hook 격리(저장 실패해도 스트림/저장 완료 무영향)와 figures 저장
# 스케줄링(retrieved 유무)만 검증한다. chat_stream generator를 최소 목으로 구동.
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
    for line in (
        "@concept: 첫째\n",
        "- 본문1\n",
        "@end\n",
        "@concept: 둘째\n",
        "- 본문2\n",
        "@end\n",
    ):
        yield line


async def _consume(monkeypatch, *, retrieved=None):
    """chat_stream을 최소 목으로 구동해 방출 SSE 이벤트 목록 + 스케줄된 코루틴 반환."""
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

    def fake_compose(*a, **k):
        return ("sys", [])

    monkeypatch.setattr(C.gemini, "compose_system_structured", fake_compose)
    monkeypatch.setattr(C.exaone, "CONCEPT_CARD_SYSTEM_PROMPT", "base", raising=False)
    monkeypatch.setattr(C.exaone, "stream_answer", _fake_stream_answer)

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

    # done-hook(create_task)이 실제로 스케줄됐는지 추적 — 실행은 하지 않음.
    scheduled = []
    real_create_task = asyncio.create_task

    def spy_create_task(coro, *a, **k):
        scheduled.append(coro)
        coro.close()  # 코루틴 미실행 경고 방지(스케줄 여부만 확인)

        async def _noop():
            return None

        return real_create_task(_noop())

    monkeypatch.setattr(C.asyncio, "create_task", spy_create_task)

    body = ChatStreamBody(session_id="s1", question="질문", retrieved=retrieved)
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
async def test_stream_emits_no_place_event(monkeypatch):
    """서버는 place/settle을 계산·전송하지 않는다 — token/done만."""
    events, _ = await _consume(monkeypatch)
    names = _event_names(events)
    assert "error" not in names
    assert "done" in names
    assert "place" not in names
    assert not any('"is_final"' in e for e in events)


@pytest.mark.asyncio
async def test_canvas_save_scheduled_only_when_retrieved(monkeypatch):
    """retrieved가 있으면 attachments.canvas(figures) 저장이 스케줄되고,
    없으면 스케줄되지 않는다(done-hook은 그래도 정상 완료)."""
    # retrieved 없음 → 저장 스케줄 없음
    events, scheduled = await _consume(monkeypatch, retrieved=None)
    assert "done" in _event_names(events)
    assert len(scheduled) == 0

    # retrieved 있음 → 저장 1회 스케줄
    retrieved = RetrievedBody()
    events, scheduled = await _consume(monkeypatch, retrieved=retrieved)
    assert "done" in _event_names(events)
    assert len(scheduled) == 1
