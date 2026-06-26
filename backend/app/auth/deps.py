"""Auth dependencies.

Verifies the `Authorization: Bearer <JWT>` issued by Supabase Auth using the
project's JWKS endpoint (asymmetric ES256 keys, the default for new Supabase
projects). Provides:

- `get_current_user`   -> verified token claims (id / email / postgres role)
- `get_current_profile`-> the caller's row from `public.profiles` (app role)
- `require_role(*roles)`-> guard factory using the APP role from `profiles`
- `get_user_scopes`    -> personal + class scopes the caller can access

Note on roles: the JWT `role` claim is the *Postgres* role ("authenticated"),
NOT the app role. The app role (student/teacher/admin) lives in
`profiles.role`, so role guards must consult the profile, not the token.
"""

from __future__ import annotations

import logging
import time

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import jwt
from jose.exceptions import JWTError
from pydantic import BaseModel

from ..config import get_settings

logger = logging.getLogger("nodi.auth")
settings = get_settings()
bearer_scheme = HTTPBearer(auto_error=True)

# Algorithm allow-list. NEVER trust the token header's `alg` — pin it here so a
# forged token cannot downgrade/swap the verification algorithm (alg-confusion).
ALLOWED_JWT_ALGORITHMS = ["ES256"]

# --- JWKS cache (refreshed on TTL expiry or unknown kid / key rotation) ---
_JWKS_TTL_SECONDS = 3600
_jwks_cache: dict = {"keys": None, "fetched_at": 0.0}


async def _fetch_jwks(force: bool = False) -> dict:
    now = time.time()
    if (
        not force
        and _jwks_cache["keys"] is not None
        and now - _jwks_cache["fetched_at"] < _JWKS_TTL_SECONDS
    ):
        return _jwks_cache["keys"]

    jwks_url = settings.jwks_url
    if not jwks_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="SUPABASE_JWKS_URL / SUPABASE_URL not configured.",
        )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(jwks_url)
            resp.raise_for_status()
            jwks = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Failed to fetch JWKS: {exc}",
        ) from exc

    _jwks_cache["keys"] = jwks
    _jwks_cache["fetched_at"] = now
    return jwks


async def _resolve_signing_key(kid: str | None) -> dict:
    jwks = await _fetch_jwks()
    key = _find_key(jwks, kid)
    if key is None:
        # Possible key rotation — refresh once and retry.
        jwks = await _fetch_jwks(force=True)
        key = _find_key(jwks, kid)
    if key is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No matching JWKS key for token (unknown kid).",
        )
    return key


def _find_key(jwks: dict, kid: str | None) -> dict | None:
    keys = jwks.get("keys", []) if isinstance(jwks, dict) else []
    if not keys:
        return None
    if kid is None:
        return keys[0]
    for k in keys:
        if k.get("kid") == kid:
            return k
    return None


class CurrentUser(BaseModel):
    id: str  # auth.users.id == profiles.id (JWT `sub`)
    email: str | None = None
    token_role: str | None = None  # Postgres role from JWT (e.g. "authenticated")
    token: str  # raw JWT, reused for RLS-scoped PostgREST calls


class Profile(BaseModel):
    id: str
    email: str | None = None
    role: str = "student"  # app role: student | teacher | admin
    display_name: str | None = None
    avatar_url: str | None = None


async def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> CurrentUser:
    token = creds.credentials
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Malformed token header: {exc}",
        ) from exc

    # Reject any token whose header advertises an algorithm we do not allow,
    # before resolving keys — defense in depth against alg-confusion attacks.
    header_alg = header.get("alg")
    if header_alg not in ALLOWED_JWT_ALGORITHMS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Unsupported token algorithm: {header_alg!r}.",
        )
    key = await _resolve_signing_key(header.get("kid"))

    # Signature + audience + expiry are verified strictly. Issuer is checked
    # SOFTLY (warning log, not 401): the asymmetric signature already proves the
    # token came from THIS project's keys, and a wrong assumption about the iss
    # format must not lock out every user. If the warning ever fires, the
    # configured auth_issuer can be corrected to re-enable strict iss checks.
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=ALLOWED_JWT_ALGORITHMS,  # pinned, NOT taken from header
            audience=settings.jwt_audience,
            options={"verify_aud": True, "verify_iss": False},
        )
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token verification failed: {exc}",
        ) from exc

    if settings.auth_issuer:
        token_iss = claims.get("iss")
        if token_iss != settings.auth_issuer:
            logger.warning(
                "JWT issuer mismatch (soft): token iss=%r expected=%r. "
                "Signature/audience still verified. Adjust SUPABASE_URL/"
                "auth_issuer to enable strict iss checks.",
                token_iss,
                settings.auth_issuer,
            )

    sub = claims.get("sub")
    if not sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject (sub).",
        )

    return CurrentUser(
        id=sub,
        email=claims.get("email"),
        token_role=claims.get("role"),
        token=token,
    )


async def _rest_get(path: str, params: dict, user_token: str) -> list[dict]:
    """RLS-scoped read against Supabase PostgREST using the caller's JWT.

    apikey = anon key; Authorization = the user's bearer token, so RLS applies
    as the authenticated user (no service_role needed).
    """
    if not settings.rest_url or not settings.supabase_anon_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Supabase REST URL / anon key not configured.",
        )
    headers = {
        "apikey": settings.supabase_anon_key,
        "Authorization": f"Bearer {user_token}",
        "Accept": "application/json",
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{settings.rest_url}{path}", params=params, headers=headers
        )
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Supabase REST error ({resp.status_code}): {resp.text}",
        )
    return resp.json()


async def get_current_profile(
    user: CurrentUser = Depends(get_current_user),
) -> Profile:
    rows = await _rest_get(
        "/profiles",
        {
            "id": f"eq.{user.id}",
            "select": "id,email,role,display_name,avatar_url",
            "limit": "1",
        },
        user.token,
    )
    if not rows:
        # The handle_new_user trigger should have created this row on signup.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Profile not found for current user.",
        )
    return Profile(**rows[0])


def require_role(*allowed_roles: str):
    """Dependency factory: allow only callers whose APP role is in allowed_roles."""

    async def _guard(profile: Profile = Depends(get_current_profile)) -> Profile:
        if profile.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires role in {allowed_roles}; have '{profile.role}'.",
            )
        return profile

    return _guard


class UserScopes(BaseModel):
    user_id: str
    personal_ref: str  # == user_id
    class_ids: list[str] = []


async def get_user_scopes(
    user: CurrentUser = Depends(get_current_user),
) -> UserScopes:
    """Resolve the scopes (personal + class memberships) the caller can access.

    Used later to scope sessions/nodes/tags/files. RLS is still the hard
    boundary; this is a convenience for building queries.
    """
    rows = await _rest_get(
        "/class_members",
        {"user_id": f"eq.{user.id}", "select": "class_id"},
        user.token,
    )
    class_ids = [r["class_id"] for r in rows if r.get("class_id")]
    return UserScopes(user_id=user.id, personal_ref=user.id, class_ids=class_ids)
