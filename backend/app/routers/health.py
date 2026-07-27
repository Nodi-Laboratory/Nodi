"""Health / readiness endpoints (no auth).

D97: `/health/config`를 **환경 자가진단 창구**로 추가했다. 과거에는 `/health`가
Supabase 3종만 노출해서, 신규 팀원이 UPSTAGE_API_KEY 누락·판정 미설정 같은
문제를 "질문을 던져 503이 날 때"까지 알 수 없었다. 기존 `/health`는 liveness
계약이므로 응답 형태를 바꾸지 않고 그대로 둔다.

**비밀값은 절대 노출하지 않는다** — 존재 여부(bool)와 비밀이 아닌 URL·모델명만.
네트워크 도달성도 확인하지 않는다(헬스 경로에 외부 호출 금지) — 설정이
채워졌는지만 본다.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..config import get_settings
from ..services import figure_judge

router = APIRouter(tags=["health"])
settings = get_settings()


@router.get("/health")
async def health() -> dict:
    """Liveness probe + a glimpse of which integrations are configured.

    Does not expose secret values — only whether they are present.
    """
    return {
        "status": "ok",
        "service": "nodi-backend",
        "environment": settings.environment,
        "supabase_configured": bool(settings.supabase_url),
        "jwks_configured": bool(settings.jwks_url),
        "service_role_present": bool(settings.supabase_service_role_key),
    }


@router.get("/health/config")
async def health_config() -> dict:
    """설정 자가진단 — 신규 환경에서 무엇이 빠졌는지 한눈에 본다(D97).

    `ready`는 **채팅 한 턴이 성립하는 최소 조건**이다(Supabase 인증 + EXAONE +
    Upstage). 파일 업로드는 service_role이, 교과서는 judge가 추가로 필요하므로
    각 블록의 `configured`를 따로 본다.

    반환값에 비밀은 없다 — bool과 비밀이 아닌 URL·모델명뿐이다.
    """
    supabase = {
        "url_set": bool(settings.supabase_url),
        "anon_key_set": bool(settings.supabase_anon_key),
        # 미설정이면 업로드·임베딩 워커가 전부 503 (routers/files.py).
        "service_role_set": bool(settings.supabase_service_role_key),
        "jwks_url": settings.jwks_url or None,
    }
    supabase["configured"] = supabase["url_set"] and supabase["anon_key_set"]

    exaone = {
        "api_key_set": bool(settings.exaone_api_key),
        # 설정 시 dedicated(/dedicated/v1), 미설정 시 serverless(/serverless/v1).
        "mode": "dedicated" if settings.exaone_endpoint_id else "serverless",
        "model": settings.exaone_endpoint_id or settings.exaone_model,
        "base_url": settings.friendli_base_url,
    }
    exaone["configured"] = exaone["api_key_set"]

    upstage = {
        "api_key_set": bool(settings.upstage_api_key),
        "base_url": settings.upstage_base_url,
    }
    upstage["configured"] = upstage["api_key_set"]

    judge_missing = figure_judge.missing_config()
    judge = {
        "configured": not judge_missing,
        "missing": judge_missing,
        "base_url": settings.judge_base_url or None,
        "model": settings.judge_model or None,
        "pipeline_enabled": settings.figure_pipeline_enabled,
        # D103: 판정은 더 이상 교과서 업로드를 막지 않는다. 파서가 caption/
        # footnote로 라벨한 figure는 판정 없이 처리되고, 판정은 라벨이 없는
        # figure를 건지는 폴백이다. 미설정이면 그 figure만 캡션 없이 실패한다.
        "role": "fallback",
        "note": (
            "미설정이어도 교과서 업로드는 가능하다. 파서가 캡션으로 라벨하지 "
            "않은 도판만 처리되지 않는다."
        ),
    }

    qdrant = {"url": settings.qdrant_url, "configured": bool(settings.qdrant_url)}

    # 채팅 한 턴이 불가능하게 만드는 항목들 — 비어 있어야 정상.
    blocking: list[str] = []
    if not supabase["configured"]:
        blocking.append("supabase")
    if not exaone["configured"]:
        blocking.append("exaone")
    if not upstage["configured"]:
        blocking.append("upstage")

    return {
        "ready": not blocking,
        "blocking": blocking,
        "environment": settings.environment,
        "supabase": supabase,
        "exaone": exaone,
        "upstage": upstage,
        "qdrant": qdrant,
        "judge": judge,
    }
