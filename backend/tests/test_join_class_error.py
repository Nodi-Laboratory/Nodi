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
        self.seen: str | None = None

    async def rpc(self, fn: str, args: dict) -> None:
        self.seen = args.get("p_code")
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


# ── D170: 코드 정규화 ──────────────────────────────────────────────────
#
# `nodi_gen_join_code()`는 대문자·숫자만 낸다(`ABCDEFGHJKMNPQRSTUVWXYZ23456789`).
# 조회는 정확 비교라 소문자로 치면 **무엇을 쳐도 실패한다** — 프로덕션 로그에
# 같은 학생의 실패가 12번 연속으로 찍혔다(2026-08-04).


@pytest.mark.parametrize(
    ("typed", "sent"),
    [
        ("jynwj9", "JYNWJ9"),      # 소문자
        ("  JYNWJ9  ", "JYNWJ9"),  # 앞뒤 공백(복사·붙여넣기)
        ("JYN WJ9", "JYNWJ9"),     # 중간 공백(받아 적기)
        ("jYn wJ9\n", "JYNWJ9"),   # 섞인 것
    ],
)
@pytest.mark.asyncio
async def test_code_is_normalized(monkeypatch, _user, typed, sent):
    stub = _Stub(None)
    monkeypatch.setattr(me.UserClient, "from_user", lambda _u: stub)
    await me.join_class(me.JoinClassBody(code=typed), _user)

    assert stub.seen == sent


@pytest.mark.asyncio
async def test_whitespace_only_code_is_404(monkeypatch, _user):
    """공백만 남으면 DB까지 가지 않는다."""
    stub = _Stub(None)
    monkeypatch.setattr(me.UserClient, "from_user", lambda _u: stub)
    with pytest.raises(HTTPException) as ei:
        await me.join_class(me.JoinClassBody(code="   "), _user)

    assert ei.value.status_code == status.HTTP_404_NOT_FOUND
    assert stub.seen is None
