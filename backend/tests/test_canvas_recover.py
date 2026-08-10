"""**카드가 없는 답을 되살린다** (2026-08-10).

카드를 만드는 것은 화면이다(D125). 서버는 답을 `nodes`에 적고, 화면이 스트림을
다 받은 **뒤에** 카드를 저장한다. 그 사이에 브라우저가 사라지면 — 탭을 닫거나,
새로고침하거나, 신호가 끊기면 — 답만 남고 카드가 없다. 학생 눈에는 답이 통째로
날아간 것이다(실측 2026-08-10: 세 턴이 315·498·408자를 갖고 카드 0장이었다).

고정하는 계약 넷:
  1. 카드가 다 있으면 **원문을 받지 않는다** — 평소 부담이 id 조회 하나뿐이어야
     한다. 되살릴 게 없는데 대화 전문을 실어 보내면 방을 열 때마다 그 값을 낸다.
  2. 카드가 없는 노드만 골라 온다 — 이미 카드가 있는 답을 또 보내면 화면에
     같은 글이 두 장 생긴다.
  3. 답이 없는 노드(질문만 하고 끊긴 턴)는 애초에 후보가 아니다.
  4. 카드가 **한 장이라도** 있는 세션에서도 되살린다 — 예전 폴백은 캔버스가
     통째로 비었을 때만 돌아서, 그 턴이 영영 안 보였다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.services import canvas_items as svc

aio = pytest.mark.asyncio


class RecoverClient:
    """`nodes` 조회를 기록하는 UserClient 대역."""

    def __init__(self, nodes: list[dict[str, Any]], items: list[dict[str, Any]]):
        self.nodes = nodes
        self.items = items
        #: (params) 기록 — 원문을 언제 받는지 보려고 남긴다.
        self.node_queries: list[dict[str, Any]] = []

    async def select(self, table: str, params: dict) -> list[dict]:
        if table == "sessions":
            return [{"id": "s1"}]
        if table == "canvas_items":
            return self.items
        if table == "canvas_drawings":
            return []
        if table == "nodes":
            self.node_queries.append(params)
            if params["select"] == "id":
                # answer가 없는 노드는 서버가 걸러 준다(`answer=not.is.null`).
                return [{"id": n["id"]} for n in self.nodes if n.get("answer")]
            wanted = params["id"].removeprefix("in.(").removesuffix(")").split(",")
            return [n for n in self.nodes if n["id"] in wanted]
        return []


@aio
async def test_카드가_다_있으면_원문을_받지_않는다() -> None:
    c = RecoverClient(
        nodes=[{"id": "n1", "answer": "@concept: 빛|과학\n굴절이란…"}],
        items=[{"id": "i1", "node_id": "n1"}],
    )
    snap = await svc.list_canvas(c, "s1")  # type: ignore[arg-type]

    assert snap["orphan_nodes"] == []
    # id 조회 한 번뿐 — 대화 전문은 오가지 않았다.
    assert [q["select"] for q in c.node_queries] == ["id"]


@aio
async def test_카드가_없는_답만_되살린다() -> None:
    c = RecoverClient(
        nodes=[
            {"id": "n1", "answer": "이미 카드가 있다"},
            {"id": "n2", "answer": "끊긴 턴이다"},
            {"id": "n3", "answer": None},  # 질문만 하고 끊긴 턴
        ],
        items=[{"id": "i1", "node_id": "n1"}],
    )
    snap = await svc.list_canvas(c, "s1")  # type: ignore[arg-type]

    assert [n["id"] for n in snap["orphan_nodes"]] == ["n2"]
    # 되살릴 것이 있을 때만 원문을 받는다.
    assert [q["select"] for q in c.node_queries] == ["id", "id,answer,created_at"]


@aio
async def test_카드가_한_장_있어도_되살린다() -> None:
    """옛 폴백은 캔버스가 **통째로 비었을 때만** 돌았다.

    그래서 학생이 카드를 한 장이라도 갖고 있으면 끊긴 턴은 영영 안 보였다.
    질문을 여러 번 하는 것이 보통이니, 실제로는 거의 항상 안 보였다는 뜻이다.
    """
    c = RecoverClient(
        nodes=[{"id": "n9", "answer": "끊긴 턴"}],
        items=[{"id": "i1", "node_id": None}],  # 학생이 쓴 메모 — 노드가 없다
    )
    snap = await svc.list_canvas(c, "s1")  # type: ignore[arg-type]

    assert [n["id"] for n in snap["orphan_nodes"]] == ["n9"]


@aio
async def test_빈_세션은_아무것도_받지_않는다() -> None:
    c = RecoverClient(nodes=[], items=[])
    snap = await svc.list_canvas(c, "s1")  # type: ignore[arg-type]

    assert snap["orphan_nodes"] == []
    assert snap["items"] == []
    assert [q["select"] for q in c.node_queries] == ["id"]
