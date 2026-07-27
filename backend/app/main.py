"""nodi FastAPI application (Stage 0 foundation).

Boots with only config + auth (JWKS) + health/me routers. Real chat/RAG/skills
land in later stages. Must boot even when SUPABASE_SERVICE_ROLE_KEY is empty.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db.pool import close_pools
from .logging_setup import configure_logging, log_config_summary
from .routers import (
    admin,
    chat,
    files,
    health,
    home,
    me,
    nodes,
    retrieve,
    sessions,
    teacher,
)
from .services import embedding_worker, qdrant_store

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # D97: nodi.* 로거에 핸들러를 붙이고(uvicorn 기본 설정은 안 붙인다) 통합
    # 설정 상태를 1회 출력한다 — 빠진 값을 부팅 시점에 드러낸다.
    configure_logging()
    log_config_summary()
    # 임베딩 워커(워커 DSN 미설정이면 no-op). DB 풀은 첫 사용 시 지연 생성된다.
    # Qdrant 컬렉션 보장(멱등, 절대 raise 안 함 — Qdrant 다운이어도 부팅 계속).
    await qdrant_store.ensure_collections()
    embedding_worker.start(_app)
    yield
    # D104: PostgREST httpx 풀 → asyncpg 풀. 종료 시 함께 닫는다.
    embedding_worker.stop()
    await close_pools()


app = FastAPI(
    title="nodi backend",
    version="0.1.0",
    description="AI conversation visualized as a node/tree. Stage 1 chat core.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(me.router)
app.include_router(sessions.router)
app.include_router(nodes.router)
app.include_router(chat.router)
app.include_router(home.router)
app.include_router(admin.router)
app.include_router(files.router)
app.include_router(teacher.router)
app.include_router(retrieve.router)


@app.get("/", tags=["health"])
async def root() -> dict:
    return {"service": "nodi-backend", "version": "0.1.0", "docs": "/docs"}
