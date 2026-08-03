"""upsert의 ON CONFLICT 절 생성 검증 (D149 fix).

행 전체가 곧 충돌 키인 멱등 삽입(class_lecture_packages 등)에서 예전 코드는
`DO UPDATE SET `(빈 SET)을 내 Postgres 문법 오류였다. 이 경우 `DO NOTHING`을
내야 한다. mock 스위트는 실제 SQL을 실행하지 않아 못 잡으므로, 실행되는 SQL
문자열을 가로채 검증한다.
"""

import contextlib

import pytest

from app.db import client as C


class _FakeConn:
    pass


def _capture(monkeypatch) -> list[str]:
    """upsert가 실행하는 SQL을 잡아 반환. _fetch는 빈 결과를 돌려준다."""
    captured: list[str] = []

    @contextlib.asynccontextmanager
    async def _fake_conn(self):
        yield _FakeConn()

    async def _fake_prepare(conn):
        return None

    async def _fake_fetch(conn, sql, args):
        captured.append(sql)
        return []  # 빈 결과 — DO NOTHING(이미 존재) 경로를 태운다

    monkeypatch.setattr(C.UserClient, "_conn", _fake_conn)
    monkeypatch.setattr(C, "_prepare", _fake_prepare)
    monkeypatch.setattr(C, "_fetch", _fake_fetch)
    return captured


async def test_all_key_upsert_uses_do_nothing(monkeypatch):
    captured = _capture(monkeypatch)
    client = C.UserClient("u1")
    # 컬럼이 전부 충돌 키 — 갱신할 비-키 컬럼이 없다.
    result = await client.upsert(
        "class_lecture_packages",
        {"class_id": "c1", "package_id": "p1"},
        on_conflict="class_id,package_id",
    )
    sql = captured[0]
    assert "DO NOTHING" in sql
    assert "DO UPDATE SET" not in sql
    # 이미 존재(빈 RETURNING)여도 502로 죽지 않고 삽입하려던 행을 돌려준다.
    assert result == {"class_id": "c1", "package_id": "p1"}


async def test_mixed_columns_still_do_update(monkeypatch):
    captured = _capture(monkeypatch)
    client = C.UserClient("u1")
    # 비-키 컬럼(value)이 있으면 기존 DO UPDATE 경로 그대로.
    with pytest.raises(Exception):
        # 빈 RETURNING + DO UPDATE → 502. SQL만 확인하면 되므로 예외는 무시.
        await client.upsert(
            "app_settings",
            {"key": "k1", "value": "v1"},
            on_conflict="key",
        )
    sql = captured[0]
    assert "DO UPDATE SET" in sql
    assert 'value = EXCLUDED.value' in sql or '"value" = EXCLUDED."value"' in sql
    assert "DO NOTHING" not in sql
