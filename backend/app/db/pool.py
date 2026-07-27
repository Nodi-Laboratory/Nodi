"""asyncpg 커넥션 풀 — 사용자용/워커용 2종 (D104-3).

구 PostgREST 구성의 UserClient/ServiceClient 구분을 **DB 역할**로 재현한다.

  nodi_app     RLS 적용. 사용자 요청 경로. 트랜잭션마다 `SET LOCAL app.user_id`.
  nodi_worker  BYPASSRLS. 백그라운드 워커·인증(구 service_role).

**사용자 스코프 커넥션은 반드시 `user_conn()`으로만 얻는다.** 이 함수가
트랜잭션 시작과 `SET LOCAL`을 한 묶음으로 보장한다. 풀에서 직접 acquire하면
앞 요청의 컨텍스트가 남은 채 질의가 나갈 수 있다 — 그 경로를 만들지 않는다.

SET LOCAL은 트랜잭션 스코프라 커밋/롤백 시 자동으로 사라진다(실측 확인).
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg

from ..config import get_settings

logger = logging.getLogger("nodi.db")
settings = get_settings()

_app_pool: asyncpg.Pool | None = None
_worker_pool: asyncpg.Pool | None = None


async def _create(dsn: str, name: str) -> asyncpg.Pool:
    logger.info("DB 풀 생성: %s", name)
    return await asyncpg.create_pool(
        dsn,
        min_size=1,
        max_size=10,
        # 준비된 문장 캐시는 PgBouncer 등 트랜잭션 풀러와 충돌한다. 지금은 직결이라
        # 켜 두되, 풀러를 넣게 되면 여기를 끈다.
        command_timeout=30,
    )


async def get_app_pool() -> asyncpg.Pool:
    """RLS가 적용되는 사용자 요청용 풀."""
    global _app_pool
    if _app_pool is None:
        _app_pool = await _create(settings.database_url, "nodi_app")
    return _app_pool


async def get_worker_pool() -> asyncpg.Pool | None:
    """BYPASSRLS 워커용 풀. DSN 미설정이면 None(구 service_role 부재와 동형)."""
    global _worker_pool
    if not settings.database_worker_url:
        return None
    if _worker_pool is None:
        _worker_pool = await _create(settings.database_worker_url, "nodi_worker")
    return _worker_pool


async def close_pools() -> None:
    """FastAPI shutdown에서 호출."""
    global _app_pool, _worker_pool
    for pool in (_app_pool, _worker_pool):
        if pool is not None:
            await pool.close()
    _app_pool = None
    _worker_pool = None


@asynccontextmanager
async def user_conn(user_id: str | None) -> AsyncIterator[asyncpg.Connection]:
    """사용자 컨텍스트가 세팅된 트랜잭션 커넥션.

    user_id가 None이면 컨텍스트를 세팅하지 않는다 — 정책들이 NULL 비교로 전부
    거짓이 되어 **아무것도 안 보이는** 안전한 상태가 된다(실측 확인).
    """
    pool = await get_app_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            if user_id:
                # set_config(…, true) = SET LOCAL. 식별자 보간이 아니라 값
                # 바인딩이므로 주입 위험이 없다.
                await conn.execute(
                    "select set_config('app.user_id', $1, true)", str(user_id)
                )
            yield conn


@asynccontextmanager
async def worker_conn() -> AsyncIterator[asyncpg.Connection]:
    """워커용 트랜잭션 커넥션(RLS 우회). 풀 미구성이면 RuntimeError."""
    pool = await get_worker_pool()
    if pool is None:
        raise RuntimeError("worker DB 풀이 구성되지 않았다(DATABASE_WORKER_URL)")
    async with pool.acquire() as conn:
        async with conn.transaction():
            yield conn
