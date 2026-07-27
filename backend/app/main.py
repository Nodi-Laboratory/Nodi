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
from .services import qdrant_store, worker

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
    worker.start(_app)
    yield
    # D104: PostgREST httpx 풀 → asyncpg 풀. 종료 시 함께 닫는다.
    worker.stop()
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

# D105: 도메인 라우터는 전부 `/api` 아래로 모은다.
#
# 예전에는 /home·/admin·/teacher가 프론트 **페이지 경로와 같은 이름**이었다.
# 그래서 배포에서 공통 접두사 없이 리라이트할 수 없어, next.config가
# `/api/:path* → :8000/:path*`로 접두사를 벗겨 넘기는 편법을 썼다. 그 결과
# 로컬(:8000 직접)과 배포(/api 경유)의 경로가 갈라져, 한쪽에서만 나는 버그가
# 생길 수 있었다. 접두사를 백엔드가 직접 가지면 양쪽이 같아진다.
#
# health는 일부러 접두사 밖에 둔다 — 인프라 liveness 프로브의 계약이고
# (README `GET /health`), API 클라이언트가 아니라 운영자가 호출한다.
app.include_router(health.router)
for _router in (
    me.router,
    sessions.router,
    nodes.router,
    chat.router,
    home.router,
    admin.router,
    files.router,
    teacher.router,
    retrieve.router,
):
    app.include_router(_router, prefix="/api")


@app.get("/", tags=["health"])
async def root() -> dict:
    return {"service": "nodi-backend", "version": "0.1.0", "docs": "/docs"}
