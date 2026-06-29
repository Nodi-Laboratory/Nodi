"""Current-user endpoints — verified-token gated."""

from __future__ import annotations

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
from ..services import app_settings
from ..services.supabase_client import UserClient

settings = get_settings()
router = APIRouter(prefix="/auth", tags=["auth"])


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


@router.get("/me/navigator-defaults")
async def get_navigator_defaults(
    _user: CurrentUser = Depends(get_current_user),
) -> dict[str, int]:
    """Effective navigator defaults = config baseline ⊕ admin app_settings override.

    Lets the workspace settings UI show the REAL applied numbers (not "기본")
    even for non-admins (D55b). Returns ``{question_count, gate_k, period}``.

    D64: this now resolves through the SAME app_settings overlay + accessors +
    clamps that navigator.maybe_generate uses for the actual gate, so the value
    shown here can no longer drift from the value enforced at generation time.
    The overlay reads via the service-role client (app_settings is admin-RLS)
    and falls back to config on any failure — never an error, never a leak.
    """
    overlay = await app_settings.get_overlay()
    return {
        "question_count": app_settings.as_int(
            overlay,
            "navigator_question_count",
            settings.navigator_question_count,
            1,
            5,
        ),
        "gate_k": app_settings.as_int(
            overlay, "navigator_k", settings.navigator_gate_k, 1, 10
        ),
        "period": app_settings.as_int(
            overlay, "navigator_period", settings.navigator_period, 1, 20
        ),
    }


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
