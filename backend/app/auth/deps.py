"""Auth dependencies (D104-4: 자체 인증).

`Authorization: Bearer <JWT>`를 **서버 시크릿으로 로컬 검증**한다. 구성에서는
Supabase JWKS를 받아 ES256으로 검증했는데, 그 왕복·캐시·kid 매칭이 전부 사라졌다.

제공:
- `get_current_user`    -> 검증된 클레임 (id / email)
- `get_current_profile` -> 호출자의 `public.profiles` 행 (앱 역할)
- `require_role(*roles)`-> 앱 역할 가드
- `get_user_scopes`     -> 접근 가능한 personal + class 스코프

역할 주의: 앱 역할(student/teacher/admin)은 토큰이 아니라 **profiles.role**에
있다. 토큰에 역할을 넣으면 승격 후에도 옛 역할이 남고, 클라이언트가 들고 있는
값이라 신뢰 대상이 아니다 — 가드는 항상 프로필을 조회한다.
"""

from __future__ import annotations

import logging

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from ..config import get_settings
from .tokens import TokenError, decode_access_token

logger = logging.getLogger("nodi.auth")
settings = get_settings()
bearer_scheme = HTTPBearer(auto_error=True)


class CurrentUser(BaseModel):
    id: str  # users.id == profiles.id (JWT sub)
    email: str | None = None


class Profile(BaseModel):
    id: str
    email: str | None = None
    role: str = "student"  # app role: student | teacher | admin
    display_name: str | None = None
    avatar_url: str | None = None
    onboarded: bool = False  # D18 — one-time onboarding completed


async def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> CurrentUser:
    try:
        claims = decode_access_token(creds.credentials)
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc
    return CurrentUser(id=str(claims["sub"]), email=claims.get("email"))


async def get_current_profile(
    user: CurrentUser = Depends(get_current_user),
) -> Profile:
    # 지연 임포트 — db.client가 auth를 임포트하지 않지만, 순환을 만들 여지를
    # 남기지 않는다.
    from ..db.client import UserClient

    client = UserClient(user.id)
    rows = await client.select(
        "profiles",
        {
            "id": f"eq.{user.id}",
            "select": "id,email,role,display_name,avatar_url,onboarded",
            "limit": "1",
        },
    )
    if not rows:
        # 가입 시 on_auth_user_created 트리거가 만들었어야 하는 행이다.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Profile not found for current user.",
        )
    row = dict(rows[0])
    row["id"] = str(row["id"])
    return Profile(**row)


def require_role(*allowed_roles: str):
    """Dependency factory: 앱 역할이 allowed_roles에 있는 호출자만 통과."""

    async def _guard(profile: Profile = Depends(get_current_profile)) -> Profile:
        if profile.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires role in {allowed_roles}; have '{profile.role}'.",
            )
        return profile

    return _guard


async def require_admin(
    profile: Profile = Depends(get_current_profile),
) -> Profile:
    """관리자 전용 가드. 앱 역할은 토큰이 아니라 프로필에 있다."""
    if profile.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin only.",
        )
    return profile


class UserScopes(BaseModel):
    user_id: str
    personal_ref: str  # == user_id
    class_ids: list[str] = []


async def get_user_scopes(
    user: CurrentUser = Depends(get_current_user),
) -> UserScopes:
    """호출자가 접근 가능한 스코프(개인 + 가입 학급).

    RLS가 여전히 실질 경계다 — 이건 질의를 만들기 위한 편의값이다.
    """
    from ..db.client import UserClient

    client = UserClient(user.id)
    rows = await client.select(
        "class_members", {"user_id": f"eq.{user.id}", "select": "class_id"}
    )
    class_ids = [str(r["class_id"]) for r in rows if r.get("class_id")]
    return UserScopes(user_id=user.id, personal_ref=user.id, class_ids=class_ids)
