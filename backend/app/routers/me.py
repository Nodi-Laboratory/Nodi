"""인증 엔드포인트 — 가입·로그인 + 현재 사용자 (D104-4).

구성에서는 가입·로그인을 Supabase GoTrue가 처리하고 백엔드는 토큰 검증만 했다.
이제 발급까지 여기서 한다.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth.deps import (
    CurrentUser,
    Profile,
    UserScopes,
    get_current_profile,
    get_current_user,
    get_user_scopes,
)
from ..auth.email import EmailAddress
from ..auth.tokens import create_access_token
from ..db.client import UserClient
from ..services import accounts

router = APIRouter(prefix="/auth", tags=["auth"])


class SignupBody(BaseModel):
    email: EmailAddress
    password: str = Field(min_length=accounts.MIN_PASSWORD_LENGTH, max_length=200)
    display_name: str | None = Field(default=None, max_length=80)
    # 화이트리스트 밖 값은 트리거가 student로 떨어뜨린다(D99). 여기서 422를
    # 내지 않는 이유: 역할 요구가 공격이든 오타든 가입 자체는 성립해야 한다.
    role: str = "student"


class LoginBody(BaseModel):
    email: EmailAddress
    password: str = Field(max_length=200)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    email: str | None = None


@router.post("/signup", response_model=TokenResponse, status_code=201)
async def signup(body: SignupBody) -> TokenResponse:
    """가입 후 곧바로 로그인 상태로 만든다(이메일 확인 단계 없음)."""
    user = await accounts.create_account(
        email=body.email,
        password=body.password,
        display_name=(body.display_name or "").strip() or None,
        role=body.role,
    )
    uid = str(user["id"])
    return TokenResponse(
        access_token=create_access_token(uid, user["email"]),
        user_id=uid,
        email=user["email"],
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginBody) -> TokenResponse:
    """이메일·비밀번호 로그인.

    계정 없음과 비밀번호 불일치를 **같은 401**로 응답한다 — 응답 차이로 계정
    존재 여부가 새지 않게.
    """
    user = await accounts.authenticate(
        body.email, body.password
    )
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="이메일 또는 비밀번호가 올바르지 않습니다.",
        )
    return TokenResponse(
        access_token=create_access_token(user["id"], user["email"]),
        user_id=user["id"],
        email=user["email"],
    )


@router.get("/me", response_model=Profile)
async def get_me(profile: Profile = Depends(get_current_profile)) -> Profile:
    """인증된 호출자의 `public.profiles` 행."""
    return profile


@router.get("/me/token")
async def get_me_token(user: CurrentUser = Depends(get_current_user)) -> dict:
    """검증된 토큰에서 얻는 최소 신원(DB 조회 없음)."""
    return {"id": user.id, "email": user.email}


@router.get("/me/scopes", response_model=UserScopes)
async def get_me_scopes(scopes: UserScopes = Depends(get_user_scopes)) -> UserScopes:
    """접근 가능한 개인·학급 스코프."""
    return scopes


@router.post("/complete-onboarding")
async def complete_onboarding(
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """온보딩 완료 표시(D18). 멱등.

    mark_onboarded() RPC를 쓰는 이유: 정책이 display_name/avatar_url만 UPDATE를
    허용해 `onboarded`는 직접 PATCH할 수 없다.
    """
    client = UserClient.from_user(user)
    await client.rpc("mark_onboarded", {})
    return {"onboarded": True}

