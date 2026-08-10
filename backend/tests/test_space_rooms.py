"""세션 선택 화면의 대화방 목록 (사용자 지시 2026-08-09).

고정하는 계약:
  1. 개념은 **많이 이야기한 순**이다 — 최신순이 아니다. 그 방을 대표하는 것은
     방금 스친 개념이 아니라 오래 붙들고 있던 개념이다.
  2. 개념 집계가 **한 번의 질의**로 끝난다 — 방마다 물으면 방 60개에 왕복 60번.
  3. 개념 집계가 실패해도 **목록은 나온다** — 칩이 없다고 방을 못 고르면 안 된다.
  4. 개인 공간의 `space_ref`는 **그 사람 자신**이다(`sessions.create_session`과
     같은 규칙). 안 그러면 개인 방이 하나도 안 뜬다.
  5. 최근 목록의 개인 공간 이름은 **"개인 세션"**이다 — 학급 이름과 나란히
     서는 자리라 사람 이름이 뜨면 그게 학급인 줄 읽힌다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.services import space_rooms

aio = pytest.mark.asyncio

ME = "11111111-1111-4111-8111-111111111111"
CLASS = "22222222-2222-4222-8222-222222222222"


class FakeClient:
    def __init__(self, *, items: list[dict] | None = None, boom_items: bool = False):
        self.boom_items = boom_items
        self.items = items if items is not None else [
            # r1 — 물리 2장 · 생명 1장이라 **물리가 앞**이어야 한다.
            {"session_id": "r1", "tag": "생명"},
            {"session_id": "r1", "tag": "물리"},
            {"session_id": "r1", "tag": "물리"},
            {"session_id": "r2", "tag": "지구과학"},
        ]
        self.calls: list[dict[str, Any]] = []

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        self.calls.append({"table": table, **params})
        if table == "sessions":
            return [
                {
                    "id": "r1",
                    "title": "빛 이야기",
                    "updated_at": "2026-08-09T02:00:00Z",
                    "space_kind": "personal",
                    "space_ref": ME,
                },
                {
                    "id": "r2",
                    "title": "",
                    "updated_at": "2026-08-09T01:00:00Z",
                    "space_kind": "class",
                    "space_ref": CLASS,
                },
            ]
        if table == "canvas_items":
            if self.boom_items:
                raise RuntimeError("집계 실패")
            return self.items
        return []


@aio
async def test_개념은_많이_이야기한_순이다():
    c = FakeClient()
    rows = await space_rooms.rooms(c, ME, "personal", None)
    r1 = next(r for r in rows if r["id"] == "r1")
    assert r1["concepts"] == ["물리", "생명"]


@aio
async def test_개념은_질의_한_번으로_모은다():
    c = FakeClient()
    await space_rooms.rooms(c, ME, "personal", None)
    items = [x for x in c.calls if x["table"] == "canvas_items"]
    assert len(items) == 1, "방마다 물으면 왕복이 방 수만큼 는다"
    # 방 id가 한 번에 들어가야 그 한 번으로 끝난다.
    assert "r1" in items[0]["session_id"] and "r2" in items[0]["session_id"]


@aio
async def test_개념_집계가_실패해도_목록은_나온다():
    c = FakeClient(boom_items=True)
    rows = await space_rooms.rooms(c, ME, "personal", None)
    assert [r["id"] for r in rows] == ["r1", "r2"]
    assert all(r["concepts"] == [] for r in rows)


@aio
async def test_개인_공간의_ref는_자기_자신이다():
    c = FakeClient()
    await space_rooms.rooms(c, ME, "personal", None)
    sess = next(x for x in c.calls if x["table"] == "sessions")
    assert sess["space_ref"] == f"eq.{ME}"


@aio
async def test_학급인데_ref가_없으면_빈_목록이다():
    c = FakeClient()
    assert await space_rooms.rooms(c, ME, "class", None) == []
    assert not c.calls, "물어볼 곳이 없으면 질의도 안 나간다"


@aio
async def test_최근_목록은_공간_이름을_함께_준다(monkeypatch):
    async def fake_spaces(client, user_id):
        return [
            {"space_kind": "personal", "space_ref": ME, "name": "홍길동"},
            {"space_kind": "class", "space_ref": CLASS, "name": "3학년 1반"},
        ]

    monkeypatch.setattr(space_rooms.home, "get_my_spaces", fake_spaces)
    rows = await space_rooms.recent(FakeClient(), ME)
    names = {r["id"]: r["space_name"] for r in rows}
    # 개인은 사람 이름이 아니라 **"개인 세션"**이다.
    assert names["r1"] == "개인 세션"
    assert names["r2"] == "3학년 1반"


@aio
async def test_공간이_없으면_최근도_비어_있다(monkeypatch):
    async def none(client, user_id):
        return []

    monkeypatch.setattr(space_rooms.home, "get_my_spaces", none)
    c = FakeClient()
    assert await space_rooms.recent(c, ME) == []
    assert not c.calls
