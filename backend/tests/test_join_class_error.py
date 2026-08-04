"""D169 회귀 — 잘못된 학급 코드는 404이지 502가 아니다.

`UserClient.rpc`는 어떤 DB 예외든 `_fail()`로 **HTTPException 502**로 바꿔
`raise ... from exc` 한다. 그래서 라우터의 `except Exception` 분기는 닿지 않았고,
코드를 잘못 친 학생에게 안내 대신 "Database request failed."가 떴다(실측).
"""

import asyncpg
import pytest
from fastapi import HTTPException, status

from app.routers import me


class _Stub:
    """rpc가 실패하는 클라이언트. 실제 경로와 같은 모양으로 예외를 쌓는다."""

    def __init__(self, cause: Exception | None) -> None:
        self._cause = cause

    async def rpc(self, fn: str, args: dict) -> None:
        if self._cause is None:
            return None
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Database request failed.",
        ) from self._cause


@pytest.fixture
def _user():
    class U:
        id = "cb6da555-d3b1-4456-a9ca-849bcbf072b5"

    return U()


async def _call(monkeypatch, cause, user):
    monkeypatch.setattr(me.UserClient, "from_user", lambda _u: _Stub(cause))
    return await me.join_class(me.JoinClassBody(code="ZZZZZZ"), user)


@pytest.mark.asyncio
async def test_invalid_code_is_404(monkeypatch, _user):
    """P0002(invalid_join_code) → 404 + 한국어 안내."""
    cause = asyncpg.exceptions.NoDataFoundError("invalid_join_code")
    with pytest.raises(HTTPException) as ei:
        await _call(monkeypatch, cause, _user)

    assert ei.value.status_code == status.HTTP_404_NOT_FOUND
    assert "학급 코드" in ei.value.detail


@pytest.mark.asyncio
async def test_other_db_error_stays_502(monkeypatch, _user):
    """진짜 DB 장애를 404로 둔갑시키지 않는다 — 코드 탓으로 오인하면 안 된다."""
    cause = asyncpg.exceptions.PostgresConnectionError("boom")
    with pytest.raises(HTTPException) as ei:
        await _call(monkeypatch, cause, _user)

    assert ei.value.status_code == status.HTTP_502_BAD_GATEWAY


@pytest.mark.asyncio
async def test_success_returns_joined(monkeypatch, _user):
    assert await _call(monkeypatch, None, _user) == {"joined": True}
