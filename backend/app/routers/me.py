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
from ..services.supabase_client import UserClient

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
