"""Current-user endpoints — verified-token gated."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends

from ..auth.deps import (
    CurrentUser,
    Profile,
    UserScopes,
    get_current_profile,
    get_current_user,
    get_user_scopes,
)
from ..config import get_settings
from ..services.service_client import get_service_client
from ..services.supabase_client import UserClient

logger = logging.getLogger("nodi.me")
settings = get_settings()
router = APIRouter(prefix="/auth", tags=["auth"])

# D55b: app_settings keys that hold the admin override for each navigator default.
# Only these PUBLIC, non-sensitive tuning values are exposed (no secrets).
_NAV_DEFAULT_KEYS = {
    "question_count": "navigator_question_count",
    "gate_k": "navigator_k",
    "period": "navigator_period",
}


@router.get("/me", response_model=Profile)
async def get_me(profile: Profile = Depends(get_current_profile)) -> Profile:
    """Return the authenticated caller's profile from `public.profiles`."""
    return profile


@router.get("/me/token")
async def get_me_token(user: CurrentUser = Depends(get_current_user)) -> dict:
    """Lightweight identity from the verified JWT (no DB read)."""
    return {"id": user.id, "email": user.email, "token_role": user.token_role}


@router.get("/me/scopes", response_model=UserScopes)
async def get_me_scopes(scopes: UserScopes = Depends(get_user_scopes)) -> UserScopes:
    """Personal + class scopes the caller can access (for scoped queries)."""
    return scopes


def _coerce_int(value: Any) -> int | None:
    """Best-effort jsonb-number -> int (app_settings values are jsonb)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@router.get("/me/navigator-defaults")
async def get_navigator_defaults(
    _user: CurrentUser = Depends(get_current_user),
) -> dict[str, int]:
    """Effective navigator defaults = config baseline ⊕ admin app_settings override.

    Lets the workspace settings UI show the REAL applied numbers (not "기본")
    even for non-admins (D55b). Returns ``{question_count, gate_k, period}``.

    app_settings is admin-RLS, so a non-admin's own JWT cannot read the override.
    To synthesize the public defaults for everyone we read ONLY the three
    whitelisted, non-sensitive navigator keys via the service-role client
    (read-only, best-effort). If the service key is unset or the read fails, the
    static config defaults apply — never an error, never a leak of other keys.
    """
    defaults = {
        "question_count": settings.navigator_question_count,
        "gate_k": settings.navigator_gate_k,
        "period": settings.navigator_period,
    }
    service = get_service_client()
    if service is not None:
        try:
            keys = ",".join(_NAV_DEFAULT_KEYS.values())
            rows = await service.select(
                "app_settings",
                {"key": f"in.({keys})", "select": "key,value"},
            )
            by_key = {r.get("key"): r.get("value") for r in rows}
            for out_field, setting_key in _NAV_DEFAULT_KEYS.items():
                override = _coerce_int(by_key.get(setting_key))
                if override is not None:
                    defaults[out_field] = override
        except Exception:  # noqa: BLE001 - override is optional; fall back to config
            logger.warning("navigator-defaults override read failed; using config")
    return defaults


@router.post("/complete-onboarding")
async def complete_onboarding(
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Mark the caller's onboarding complete (D18). Idempotent.

    Uses the mark_onboarded() RPC because 0003 only grants UPDATE on
    display_name/avatar_url to authenticated, so `onboarded` can't be PATCHed.
    """
    client = UserClient.from_user(user)
    await client.rpc("mark_onboarded", {})
    return {"onboarded": True}
