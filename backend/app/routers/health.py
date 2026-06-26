"""Health / readiness endpoints (no auth)."""

from __future__ import annotations

from fastapi import APIRouter

from ..config import get_settings

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
        "gemini_configured": bool(settings.google_gemini_api_key),
    }
