"""자체 인증 — 비밀번호 해시 · 액세스 토큰 (D104-4).

Supabase GoTrue를 대체한다. 구성에서 달라진 점:

  발급   GoTrue(원격 ES256 + JWKS 왕복)  →  우리가 HS256으로 서명
  검증   JWKS 다운로드·캐시·kid 매칭     →  서버 시크릿으로 로컬 검증

JWKS 왕복이 사라져 요청당 네트워크 의존이 하나 준다. 대신 시크릿 관리 책임이
우리에게 온다 — 운영에서 기본값을 쓰면 부팅 시 경고한다(logging_setup).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import bcrypt
import jwt

from ..config import get_settings

logger = logging.getLogger("nodi.auth.tokens")
settings = get_settings()

# 알고리즘은 **고정**한다. 토큰 헤더의 alg를 믿으면 alg-confusion으로 서명
# 검증을 우회당할 수 있다(구 구현도 같은 이유로 화이트리스트를 뒀다).
ALGORITHM = "HS256"


# --- 비밀번호 ----------------------------------------------------------------
def hash_password(plain: str) -> str:
    """bcrypt 해시. DB 시드(pgcrypto crypt)와 같은 알고리즘이라 상호 호환된다."""
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    """해시 검증. 잘못된 형식의 해시에도 예외 대신 False를 돌려준다.

    (DB에 손상된 값이 있어도 500이 아니라 '로그인 실패'로 떨어져야 한다.)
    """
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except (ValueError, TypeError):
        logger.warning("비밀번호 해시 형식 오류 — 검증 실패로 처리")
        return False


# --- 액세스 토큰 --------------------------------------------------------------
def create_access_token(user_id: str, email: str | None = None) -> str:
    """sub=user_id인 액세스 토큰. 만료는 config의 jwt_expire_minutes."""
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "iat": now,
        "exp": now + timedelta(minutes=settings.jwt_expire_minutes),
    }
    if email:
        payload["email"] = email
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALGORITHM)


class TokenError(Exception):
    """검증 실패 — 호출부가 401로 변환한다."""


def decode_access_token(token: str) -> dict[str, Any]:
    """토큰 검증 후 클레임 반환. 실패는 TokenError."""
    try:
        return jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[ALGORITHM],  # 고정 — 헤더의 alg를 쓰지 않는다
            options={"require": ["sub", "exp"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenError("토큰이 만료되었습니다.") from exc
    except jwt.InvalidTokenError as exc:
        raise TokenError("토큰이 유효하지 않습니다.") from exc
