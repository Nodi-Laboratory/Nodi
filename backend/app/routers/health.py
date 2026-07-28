"""Health / readiness endpoints (no auth).

D97: `/health/config`는 **환경 자가진단 창구**다. 신규 팀원이 자기 `.env`에
무엇이 빠졌는지 브라우저 한 번으로 확인한다.

D104: Supabase 3종(url/anon/service_role) 대신 Postgres DSN 2종을 본다.

**비밀값은 절대 노출하지 않는다** — 존재 여부(bool)와 비밀이 아닌 URL·모델명만.
네트워크 도달성도 확인하지 않는다(헬스 경로에 외부 호출 금지).
"""

from __future__ import annotations

from fastapi import APIRouter

from ..config import get_settings
from ..services import figure_judge

router = APIRouter(tags=["health"])
settings = get_settings()


def _dsn_host(dsn: str) -> str | None:
    """DSN에서 비밀번호를 뺀 host/db만. 진단에 자격증명을 싣지 않는다."""
    if not dsn:
        return None
    tail = dsn.rsplit("@", 1)[-1]
    return tail or None


@router.get("/health")
async def health() -> dict:
    """Liveness probe + 어떤 통합이 구성됐는지 한눈에.

    비밀값은 노출하지 않는다 — 존재 여부만.
    """
    return {
        "status": "ok",
        "service": "nodi-backend",
        "environment": settings.environment,
        "db_configured": bool(settings.database_url),
        "worker_configured": bool(settings.database_worker_url),
    }


@router.get("/health/config")
async def health_config() -> dict:
    """설정 자가진단 — 신규 환경에서 무엇이 빠졌는지 한눈에 본다.

    `ready`는 **채팅 한 턴이 성립하는 최소 조건**이다(DB + Upstage).
    파일 업로드는 worker DSN이, 교과서는 judge가 추가로 필요하므로 각 블록의
    `configured`를 따로 본다.
    """
    database = {
        "app_dsn_set": bool(settings.database_url),
        # 미설정이면 업로드·임베딩 워커가 전부 503 (구 service_role 부재와 동형).
        "worker_dsn_set": bool(settings.database_worker_url),
        "host": _dsn_host(settings.database_url),
    }
    database["configured"] = database["app_dsn_set"]

    auth = {
        "jwt_algorithm": settings.jwt_algorithm,
        "expire_minutes": settings.jwt_expire_minutes,
        # 기본 시크릿이면 누구나 토큰을 위조할 수 있다 — 운영 전 반드시 교체.
        "secret_is_default": settings.jwt_secret == "dev-only-change-me",
        "configured": bool(settings.jwt_secret),
    }

    # D108: 대화 생성도 Upstage로 옮겨져 키가 하나다. 그래도 블록은 둘로
    # 나눠 둔다 — 무엇이 안 되는지(생성인지 임베딩인지)가 진단에서 갈린다.
    chat = {
        "api_key_set": bool(settings.upstage_api_key),
        "model": settings.upstage_chat_model,
        "base_url": settings.upstage_base_url,
    }
    chat["configured"] = chat["api_key_set"]

    upstage = {
        "api_key_set": bool(settings.upstage_api_key),
        "base_url": settings.upstage_base_url,
        "embedding_query_model": settings.upstage_embedding_query_model,
        "embedding_passage_model": settings.upstage_embedding_passage_model,
    }
    upstage["configured"] = upstage["api_key_set"]

    judge_missing = figure_judge.missing_config()
    judge = {
        "configured": not judge_missing,
        "missing": judge_missing,
        "base_url": settings.judge_base_url or None,
        "model": settings.judge_model or None,
        "pipeline_enabled": settings.figure_pipeline_enabled,
        # D103: 판정은 교과서 업로드를 막지 않는다 — 파서가 캡션으로 라벨한
        # figure는 판정 없이 처리되고, 판정은 라벨 없는 figure의 폴백이다.
        "role": "fallback",
        "note": (
            "미설정이어도 교과서 업로드는 가능하다. 파서가 캡션으로 라벨하지 "
            "않은 도판만 처리되지 않는다."
        ),
    }

    qdrant = {"url": settings.qdrant_url, "configured": bool(settings.qdrant_url)}
    storage = {"root": settings.storage_root, "bucket": settings.storage_bucket}

    # 채팅 한 턴이 불가능하게 만드는 항목들 — 비어 있어야 정상.
    blocking: list[str] = []
    if not database["configured"]:
        blocking.append("database")
    if not chat["configured"]:
        blocking.append("chat")
    if not upstage["configured"]:
        blocking.append("upstage")

    return {
        "ready": not blocking,
        "blocking": blocking,
        "environment": settings.environment,
        "database": database,
        "auth": auth,
        "chat": chat,
        "upstage": upstage,
        "qdrant": qdrant,
        "storage": storage,
        "judge": judge,
    }
