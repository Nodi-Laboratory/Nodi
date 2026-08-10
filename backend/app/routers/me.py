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
    get_current_profile,
    get_current_user,
)
from ..auth.email import EmailAddress
from ..auth.tokens import create_access_token
from ..config import get_settings
from ..db.client import UserClient
from ..services import accounts, admin_console

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()


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
    #: 토큰이 몇 초 뒤에 죽나.
    #:
    #: **화면이 이 값으로 쿠키 수명을 정한다.** 예전에는 프론트가 12시간을
    #: 따로 적어 뒀는데, 그건 같은 사실을 두 곳에 적어 둔 것이다 —
    #: `JWT_EXPIRE_MINUTES`를 줄이면 쿠키만 살아남아 "화면은 열리는데 창구는
    #: 전부 401"인 상태가 된다(가드가 로그인 화면으로 돌려보내 주기는 하지만,
    #: 애초에 어긋날 이유가 없다).
    expires_in: int = settings.jwt_expire_minutes * 60


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


@router.get("/me/classes")
async def get_me_classes(user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    """가입한 학급 목록.

    D104: 구성에서는 프론트가 Supabase 클라이언트로 class_members를 직접
    조회했다. 그 경로가 사라져 API로 옮긴다 — RLS가 계속 스코프하므로 남의
    학급은 애초에 조회되지 않는다.
    """
    client = UserClient.from_user(user)
    rows = await client.select(
        "class_members",
        {
            "user_id": f"eq.{user.id}",
            "select": "class_id,role_in_class,classes(id,name,join_code)",
        },
    )
    # UUID 등 비직렬화 타입을 문자열로 — 프론트 타입(MyClass)과 맞춘다.
    out: list[dict] = []
    for r in rows:
        cls = r.get("classes") or None
        out.append({
            "class_id": str(r["class_id"]),
            "role_in_class": r.get("role_in_class"),
            "classes": None if cls is None else {
                "id": str(cls["id"]),
                "name": cls.get("name"),
                "join_code": cls.get("join_code"),
            },
        })
    return out


class JoinClassBody(BaseModel):
    code: str = Field(min_length=1, max_length=32)


def _normalize_join_code(raw: str) -> str:
    """학급 코드를 저장된 형태로 맞춘다 (D170).

    `nodi_gen_join_code()`의 알파벳은 `ABCDEFGHJKMNPQRSTUVWXYZ23456789` —
    **언제나 대문자**다. 그런데 조회는 `where join_code = p_code`로 정확히
    비교하므로 학생이 소문자로 치면 **무엇을 쳐도 실패한다.** 화면 어디에도
    대문자로 바꿔 주는 곳이 없었다.

    공백도 지운다 — 칠판·채팅으로 받아 적다 보면 중간에 끼거나("JYN WJ9")
    복사할 때 앞뒤로 붙는다. 코드 알파벳에 공백이 없으니 지워도 잃을 것이 없다.
    """
    return "".join(raw.split()).upper()


@router.post("/me/classes")
async def join_class(
    body: JoinClassBody, user: CurrentUser = Depends(get_current_user)
) -> dict:
    """학급 코드로 가입 (D104: 구 프론트 직접 RPC 호출 대체).

    join_class_by_code는 코드가 없으면 P0002(invalid_join_code)를 던진다 —
    404로 변환해 프론트가 "유효하지 않은 코드"를 안내하게 한다.
    """
    client = UserClient.from_user(user)
    try:
        code = _normalize_join_code(body.code)
        if not code:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="유효하지 않은 학급 코드입니다.",
            )
        await client.rpc("join_class_by_code", {"p_code": code})
    except HTTPException as exc:
        # **원인은 HTTPException 안에 들어 있다** (D169). `UserClient.rpc`는 어떤
        # DB 예외든 `_fail()`로 502로 바꿔 `raise ... from exc` 한다. 그래서 아래
        # `except Exception`의 invalid_join_code 분기는 **닿을 수 없었고**, 코드를
        # 잘못 친 학생에게 "유효하지 않은 학급 코드입니다" 대신 502
        # "Database request failed."가 떴다(실측 2026-08-04). 원인 사슬을 본다.
        if "invalid_join_code" in str(exc.__cause__ or ""):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="유효하지 않은 학급 코드입니다.",
            ) from exc
        raise
    return {"joined": True}


class UpdateProfileBody(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)


@router.patch("/me")
async def update_me(
    body: UpdateProfileBody, user: CurrentUser = Depends(get_current_user)
) -> dict:
    """표시 이름 변경. 정책이 display_name/avatar_url만 UPDATE를 허용한다."""
    client = UserClient.from_user(user)
    rows = await client.update(
        "profiles",
        {"id": f"eq.{user.id}"},
        {"display_name": body.display_name.strip()},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Profile not found."
        )
    return {"display_name": rows[0].get("display_name")}


class OnboardingAnswers(BaseModel):
    """온보딩 설문 답 (D222).

    **전부 선택이다.** 형식상 받아 두는 값이라 하나도 안 적어도 시작을 막지
    않는다 — 막으면 쓰지도 않을 값 때문에 학생이 제품에 못 들어간다.
    """

    display_name: str | None = Field(default=None, max_length=40)
    grade: str | None = Field(default=None, max_length=40)
    stage: str | None = Field(default=None, max_length=40)
    goal: str | None = Field(default=None, max_length=200)


@router.put("/onboarding-answers")
async def put_onboarding_answers(
    body: OnboardingAnswers,
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """온보딩 설문을 저장한다. 멱등 — 다시 보내면 덮어쓴다.

    지금 이 값을 읽는 기능은 **하나도 없다**(사용자 확인 2026-08-11: 형식상
    받아 두는 것). 그래서 표도 따로 두고, 관리자 읽기 정책도 안 만들었다.
    """
    client = UserClient.from_user(user)
    row = {
        "user_id": user.id,
        **{k: (v.strip() or None) if isinstance(v, str) else v
           for k, v in body.model_dump().items()},
    }
    await client.upsert("onboarding_answers", row, on_conflict="user_id")
    return {"saved": True}


@router.get("/onboarding-answers")
async def get_onboarding_answers(
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """저장된 설문. 없으면 빈 값 — 처음 오는 사람이 정상이라 404가 아니다."""
    client = UserClient.from_user(user)
    rows = await client.select(
        "onboarding_answers",
        {"user_id": f"eq.{user.id}", "select": "display_name,grade,stage,goal", "limit": "1"},
    )
    got = rows[0] if rows else {}
    return {k: got.get(k) for k in ("display_name", "grade", "stage", "goal")}


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



@router.get("/settings/client")
async def get_client_settings(
    _user: CurrentUser = Depends(get_current_user),
) -> dict:
    """캔버스 화면 동작 값 (D174).

    프론트에 상수로 박혀 있던 것들이라 관리자가 아무것도 못 만졌다. 서버가
    값을 갖고 여기서 내려보낸다.

    **학생도 부르는 경로다.** 그래서 화면 동작에 쓰이는 것만 담는다 —
    거리 게이트·모델명 같은 운영 값은 `/admin/settings`에만 있다.
    """
    return await admin_console.client_settings()
