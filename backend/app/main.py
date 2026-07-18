"""nodi FastAPI application (Stage 0 foundation).

Boots with only config + auth (JWKS) + health/me routers. Real chat/RAG/skills
land in later stages. Must boot even when SUPABASE_SERVICE_ROLE_KEY is empty.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
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
from .services.service_client import aclose_service_http
from .services.supabase_client import aclose_shared_client

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Startup: embedding worker (no-op if SUPABASE_SERVICE_ROLE_KEY is unset).
    # The shared PostgREST connection pools (D65, user + worker) are created
    # lazily on first use.
    # Qdrant 컬렉션 보장(멱등, 절대 raise 안 함 — Qdrant 다운이어도 부팅 계속).
    await qdrant_store.ensure_collections()
    embedding_worker.start(_app)
    yield
    # Shutdown: stop the scheduler + close both shared httpx connection pools.
    embedding_worker.stop()
    await aclose_shared_client()
    await aclose_service_http()


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
