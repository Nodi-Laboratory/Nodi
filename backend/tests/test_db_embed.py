"""D169 회귀 — 임베디드 리소스(`classes(id,name)`)가 실제로 채워지는가.

**이 결함은 예외를 내지 않는다.** 조용히 `classes: null`이 되고, 그걸 읽는 쪽이
행을 통째로 건너뛴다(`services/home.py`) — 학생이 학급에 가입해도 **학급 공간이
목록에 아예 안 뜬다.** 사용자 신고 2026-08-04 "학급 연결이 작동하지 않는다".

원인은 타입이었다. 바깥 행은 `_rows()`를 거쳐 uuid가 **문자열**인데 임베디드
하위 질의 결과는 raw Record라 키가 `uuid.UUID`였다. 파이썬에서

    {UUID("…"): v}.get("…")   →   None

`test_db_jsonable.py`가 지키는 것과 **같은 사고가 한 겹 안쪽에서** 반복됐다.
"""

from typing import Any
from uuid import UUID

import pytest

from app.db.client import UserClient

CLASS_A = "21990429-d0ea-4415-8f80-a3dcf24ae041"
CLASS_B = "c0cec2af-867a-469a-9c0d-26f032c9ad61"
STUDENT = "cb6da555-d3b1-4456-a9ca-849bcbf072b5"


class FakeConn:
    """하위 질의만 흉내 낸다. asyncpg처럼 **UUID 객체**를 돌려주는 것이 핵심."""

    def __init__(self) -> None:
        self.sql: str | None = None

    async def fetch(self, sql: str, ids: Any) -> list[dict[str, Any]]:
        self.sql = sql
        return [
            {"id": UUID(CLASS_A), "name": "3학년 2반"},
            {"id": UUID(CLASS_B), "name": "과학 탐구 2반"},
        ]


@pytest.mark.asyncio
async def test_embed_is_filled_despite_uuid_vs_str():
    """바깥 행의 문자열 class_id로도 임베디드가 붙어야 한다."""
    conn = FakeConn()
    # 바깥 행은 이미 `_rows()`를 거친 모습 — uuid가 문자열이다.
    rows = [
        {"class_id": CLASS_A, "role_in_class": "student"},
        {"class_id": CLASS_B, "role_in_class": "student"},
    ]
    await UserClient(STUDENT)._fill_embeds(conn, rows, [("classes", ["id", "name"])])

    assert rows[0]["classes"] == {"id": CLASS_A, "name": "3학년 2반"}
    assert rows[1]["classes"] == {"id": CLASS_B, "name": "과학 탐구 2반"}


@pytest.mark.asyncio
async def test_embed_does_not_select_id_twice():
    """`SELECT id, id, name`은 중복이다 — cols에 id가 있어도 한 번만 뽑는다."""
    conn = FakeConn()
    rows = [{"class_id": CLASS_A}]
    await UserClient(STUDENT)._fill_embeds(conn, rows, [("classes", ["id", "name"])])

    assert conn.sql is not None
    assert conn.sql.count("id,") == 1, conn.sql


@pytest.mark.asyncio
async def test_missing_row_becomes_none_not_crash():
    """참조가 끊긴 행은 None으로 둔다(RLS로 안 보이는 학급 등)."""
    conn = FakeConn()
    rows = [{"class_id": "00000000-0000-0000-0000-000000000000"}]
    await UserClient(STUDENT)._fill_embeds(conn, rows, [("classes", ["id", "name"])])

    assert rows[0]["classes"] is None
