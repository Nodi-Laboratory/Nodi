"""계정 생성·인증 (D104-4) — 구 Supabase GoTrue 대체.

`public.users`를 직접 다룬다. **워커 커넥션(BYPASSRLS)만 쓴다** — 비밀번호
해시가 든 테이블이라 사용자 스코프 역할(nodi_app)에는 GRANT 자체가 없다.

역할 결정은 여기서 하지 않는다. `raw_user_meta_data.role`을 그대로 넘기면
on_auth_user_created 트리거가 화이트리스트('student'|'teacher')를 강제해
프로필을 만든다(D99) — 클라이언트가 admin을 요구해도 student로 떨어진다.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import HTTPException, status

from ..auth.tokens import hash_password, verify_password
from ..db.pool import worker_conn

logger = logging.getLogger("nodi.accounts")

# 자체 가입으로 얻을 수 있는 역할. admin은 승격(관리자 콘솔·CLI)으로만.
SIGNUP_ROLES = ("student", "teacher")

MIN_PASSWORD_LENGTH = 8


async def create_account(
    email: str, password: str, display_name: str | None, role: str
) -> dict[str, Any]:
    """계정 생성 → users 행 반환. 프로필은 트리거가 만든다.

    이메일 중복은 409. 형식·길이 검증은 호출부(라우터)에서 이미 거른 뒤다.
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"비밀번호는 {MIN_PASSWORD_LENGTH}자 이상이어야 합니다.",
        )
    meta: dict[str, Any] = {}
    if display_name:
        meta["full_name"] = display_name
    # 화이트리스트 밖 값은 아예 보내지 않는다 — 트리거도 막지만, 요청 의도가
    # 기록에 남지 않게 여기서 정리한다.
    if role in SIGNUP_ROLES:
        meta["role"] = role

    async with worker_conn() as conn:
        exists = await conn.fetchval(
            "select 1 from public.users where email = $1", email
        )
        if exists:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="이미 가입된 이메일입니다.",
            )
        row = await conn.fetchrow(
            """
            insert into public.users (email, password_hash, raw_user_meta_data)
            -- ::text::jsonb 로 **두 단계** 캐스팅한다. `$3::jsonb`만 쓰면 asyncpg가
            -- 파라미터 타입을 jsonb로 추론해 이미 직렬화된 문자열을 다시 JSON
            -- 문자열로 감싼다 — 결과가 객체가 아니라 문자열이 되어
            -- `raw_user_meta_data->>'full_name'`이 NULL을 돌려주고, 트리거가
            -- 이름·역할을 폴백해 버린다(실측: 이름이 이메일 앞부분, 역할이 student).
            values ($1, $2, $3::text::jsonb)
            returning id, email
            """,
            email,
            hash_password(password),
            json.dumps(meta),
        )
    logger.info("계정 생성: %s (요청 역할=%s)", email, role)
    return dict(row)


async def authenticate(email: str, password: str) -> dict[str, Any] | None:
    """이메일·비밀번호 검증 → users 행 (실패 시 None).

    **계정 없음과 비밀번호 불일치를 구분해 돌려주지 않는다** — 호출부가 같은
    문구로 응답해 계정 존재 여부가 새지 않게 한다.
    """
    async with worker_conn() as conn:
        row = await conn.fetchrow(
            "select id, email, password_hash from public.users where email = $1",
            email,
        )
    if row is None:
        return None
    if not verify_password(password, row["password_hash"]):
        return None
    return {"id": str(row["id"]), "email": row["email"]}


async def set_role(email: str, role: str) -> dict[str, Any]:
    """역할 승격 — 관리자 부여용(CLI). 가입 경로로는 도달할 수 없다."""
    if role not in ("student", "teacher", "admin"):
        raise ValueError(f"알 수 없는 역할: {role}")
    async with worker_conn() as conn:
        row = await conn.fetchrow(
            """
            update public.profiles p set role = $2
            from public.users u
            where u.id = p.id and u.email = $1
            returning p.id, u.email, p.role
            """,
            email,
            role,
        )
    if row is None:
        raise LookupError(f"계정을 찾을 수 없습니다: {email}")
    return dict(row)
