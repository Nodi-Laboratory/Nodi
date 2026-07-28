"""D74(백엔드) — SSE done 이벤트의 node.rag_sources 전달 + D73 호출부 배선 테스트."""

import json

import pytest

from app.routers import chat as C
from app.routers.chat import ChatStreamBody


class _FakeUser:
    id = "u1"
    email = "u@test"


class _FakeClient:
    async def update(self, *a, **k):
        return None

    async def select(self, *a, **k):
        return []


async def _fake_stream_answer(history, question, system_prompt):
    yield "@concept: 개념\n"
    yield "- 본문\n"
    yield "@end\n"


SOURCES = [
    {
        "file_id": "f1",
        "chunk_id": "ck1",
        "name": "교과서.pdf",
        "seq": 3,
        "distance": 0.21,
        "snippet": "지구과학 본문…",
    }
]


async def _consume(monkeypatch):
    """chat_stream을 최소 목으로 구동 — done 이벤트와 rag 호출 kwargs를 반환."""
    monkeypatch.setattr(
        C.UserClient, "from_user", classmethod(lambda cls, u: _FakeClient())
    )

    async def fake_get_session(client, sid):
        return {
            "owner_id": "u1",
            "current_head_id": None,
            "root_node_id": None,
            "space_kind": "class",
            "space_ref": "class-1",
        }

    async def fake_get_nodes(client, sid):
        return []

    # D109: 이 테스트들은 **기존 단발 경로**를 검증한다. 두 곳을 다 고정해야
    # 한다 — 오버레이(실 DB의 app_settings)와 config 기본값. 하나만 막으면
    # 다른 쪽으로 ReAct 분기가 새고, 결과가 환경에 따라 달라진다(둘 다 겪었다).
    async def _no_overlay():
        return {}

    monkeypatch.setattr(C.app_settings, "get_overlay", _no_overlay)
    monkeypatch.setattr(C.settings, "react_enabled", False)

    monkeypatch.setattr(C.svc, "get_session", fake_get_session)
    monkeypatch.setattr(C.svc, "get_session_nodes", fake_get_nodes)
    monkeypatch.setattr(C.svc, "ancestor_chain_nodes", lambda nodes, pid: [])

    rag_kwargs = {}

    async def fake_rag(client, query, **kwargs):
        # D82: build_rag_context 시그니처 단순화(chain 파라미터 제거).
        rag_kwargs.update(kwargs)
        return {"block": "[학급 자료에서 참고]\n- x", "sources": SOURCES}

    monkeypatch.setattr(C.rag, "build_rag_context", fake_rag)
    monkeypatch.setattr(
        C.gemini, "compose_system_structured", lambda *a, **k: ("sys", [])
    )
    monkeypatch.setattr(C.solar, "CONCEPT_CARD_SYSTEM_PROMPT", "base", raising=False)
    monkeypatch.setattr(C.solar, "stream_answer", _fake_stream_answer)

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

    body = ChatStreamBody(session_id="s1", question="질문")
    resp = await C.chat_stream(body, user=_FakeUser())
    events = []
    async for chunk in resp.body_iterator:
        events.append(chunk)
    return events, rag_kwargs


def _done_payload(events):
    for e in events:
        if e.startswith("event: done"):
            return json.loads(e.split("data: ", 1)[1])
    return None


@pytest.mark.asyncio
async def test_done_includes_rag_sources(monkeypatch):
    """⑤ done 이벤트 node에 rag_sources가 실린다(실시간 출처 칩 표시용)."""
    events, _ = await _consume(monkeypatch)
    done = _done_payload(events)
    assert done is not None
    assert done["node"]["rag_sources"] == SOURCES


@pytest.mark.asyncio
async def test_rag_called_with_session_space(monkeypatch):
    """D73 배선 — build_rag_context에 세션의 space_kind/space_ref가 전달된다."""
    _, rag_kwargs = await _consume(monkeypatch)
    assert rag_kwargs == {"space_kind": "class", "space_ref": "class-1"}
