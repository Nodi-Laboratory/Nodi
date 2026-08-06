"""RPC 반환 모양 (2026-08-07) — 행이 하나일 때 목록이 목록으로 와야 한다.

## 왜 이 테스트가 있나

`rpc()`는 반환 **모양만 보고** "행 하나짜리 목록"과 "복합 타입 하나"를 갈랐다
(행이 여럿이면 목록, 하나면 dict). 그래서 목록을 기대하는 호출부가 행이
**정확히 하나**일 때 dict를 받았고, 라우터의 `isinstance(result, list) else []`가
그걸 빈 목록으로 바꿨다.

학생·선생님에게는 이렇게 보였다: **학급을 하나만 가진 선생님에게 학급 목록이
비어 있다.** 학급 코드도 안 보이니 학생을 넣을 방법이 없다. 둘째 학급을 만들면
갑자기 둘 다 나타난다 — 새로 가입한 선생님은 100% 겪는 자리인데, 개발 계정은
보통 학급이 여럿이라 아무도 못 봤다.

이제 목록을 기대하는 쪽이 `many=True`라고 적는다. 짐작하지 않는다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.db import client as C

pytestmark = pytest.mark.asyncio


class _FakeConn:
    def __init__(self, rows: list[dict[str, Any]]):
        self._rows = rows

    async def fetch(self, sql: str, *args: Any):
        return self._rows


class _Client(C.UserClient):
    """`_conn`만 대역으로 바꾼 최소 클라이언트."""

    def __init__(self, rows: list[dict[str, Any]]):
        super().__init__("11111111-1111-4111-8111-111111111111")
        self._rows = rows

    def _conn(self):  # type: ignore[override]
        rows = self._rows

        class _Ctx:
            async def __aenter__(self):
                return _FakeConn(rows)

            async def __aexit__(self, *a):
                return False

        return _Ctx()


@pytest.fixture(autouse=True)
def _no_prepare(monkeypatch):
    async def noop(_conn):
        return None

    async def fetch(conn, sql, args):
        return await conn.fetch(sql, *args)

    monkeypatch.setattr(C, "_prepare", noop)
    monkeypatch.setattr(C, "_fetch", fetch)
    monkeypatch.setattr(C, "_rows", lambda rows: list(rows))


한_학급 = [{"id": "c1", "name": "3학년 1반", "join_code": "AB12CD"}]
두_학급 = [*한_학급, {"id": "c2", "name": "3학년 2반", "join_code": "EF34GH"}]


async def test_행이_하나여도_목록이다():
    """이 한 줄이 새 선생님의 학급 목록을 비워 놨다."""
    out = await _Client(한_학급).rpc("teacher_classes", {}, many=True)
    assert isinstance(out, list)
    assert len(out) == 1
    assert out[0]["join_code"] == "AB12CD"


async def test_행이_없으면_빈_목록이다():
    """None을 돌려주면 호출부마다 `or []`를 적어야 한다 — 잊는 곳이 생긴다."""
    out = await _Client([]).rpc("teacher_classes", {}, many=True)
    assert out == []


async def test_행이_여럿이면_그대로():
    out = await _Client(두_학급).rpc("teacher_classes", {}, many=True)
    assert [c["id"] for c in out] == ["c1", "c2"]


async def test_many를_안_주면_옛_계약_그대로():
    """스칼라(is_admin 등)·복합 타입 호출부가 많아 기본 동작은 유지한다."""
    scalar = await _Client([{"ok": True}]).rpc("is_class_teacher", {})
    assert scalar is True
    single = await _Client(한_학급).rpc("create_class", {})
    assert isinstance(single, dict)
