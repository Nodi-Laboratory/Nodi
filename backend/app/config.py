"""Application settings.

Loads configuration from the repository ROOT `.env` (one level above `backend/`).
Secrets are never hardcoded — pydantic-settings reads them from env / .env.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py -> parents[0]=app, [1]=backend, [2]=repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
ROOT_ENV = REPO_ROOT / ".env"


class Settings(BaseSettings):
    # --- Supabase ---
    supabase_url: str = ""
    supabase_project_ref: str = ""
    # JWKS endpoint used to verify ES256-signed user JWTs.
    supabase_jwks_url: str = ""
    supabase_anon_key: str = ""
    # Optional in Stage 0 — server-side privileged ops. App must boot without it.
    supabase_service_role_key: str = ""

    # --- AI ---
    google_gemini_api_key: str = ""

    # --- App ---
    # Postgres role embedded in Supabase user JWTs (NOT the app role).
    jwt_audience: str = "authenticated"
    cors_origins: list[str] = ["http://localhost:3000"]
    environment: str = "development"

    model_config = SettingsConfigDict(
        env_file=str(ROOT_ENV),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @property
    def jwks_url(self) -> str:
        """Resolved JWKS URL, derived from SUPABASE_URL if not given explicitly."""
        if self.supabase_jwks_url:
            return self.supabase_jwks_url
        if self.supabase_url:
            return f"{self.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
        return ""

    @property
    def rest_url(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/rest/v1" if self.supabase_url else ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
