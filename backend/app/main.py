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
    health,
    home,
    me,
    nodes,
    overseer,
    sessions,
    tags,
)

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Startup: (Stage 1+) apscheduler jobs (navigator, embedding workers) start here.
    yield
    # Shutdown: scheduler teardown will go here.


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
app.include_router(tags.router)
app.include_router(nodes.router)
app.include_router(chat.router)
app.include_router(home.router)
app.include_router(overseer.router)
app.include_router(admin.router)


@app.get("/", tags=["health"])
async def root() -> dict:
    return {"service": "nodi-backend", "version": "0.1.0", "docs": "/docs"}
