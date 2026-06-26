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
