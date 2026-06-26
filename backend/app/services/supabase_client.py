"""Per-request, RLS-scoped Supabase REST (PostgREST) client.

All DB access in Stage 1 goes through the CALLER'S JWT, never the service_role
key. apikey = anon key, Authorization = the user's bearer token, so Postgres
RLS evaluates every read/write as that authenticated user (owner-only writes).

Build one per request via `UserClient.from_user(current_user)`.
"""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, status

from ..config import get_settings

settings = get_settings()


class UserClient:
    def __init__(self, user_token: str):
        if not settings.rest_url or not settings.supabase_anon_key:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Supabase REST URL / anon key not configured.",
            )
        self._base = settings.rest_url
        self._token = user_token

    @classmethod
    def from_user(cls, user: Any) -> "UserClient":
        return cls(user.token)

    def _headers(self, prefer: str | None = None) -> dict[str, str]:
        h = {
            "apikey": settings.supabase_anon_key,
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if prefer:
            h["Prefer"] = prefer
        return h

    @staticmethod
    def _raise(resp: httpx.Response) -> None:
        # 403/401 from PostgREST usually means RLS blocked the op.
        code = (
            status.HTTP_403_FORBIDDEN
            if resp.status_code in (401, 403)
            else status.HTTP_502_BAD_GATEWAY
        )
        raise HTTPException(
            status_code=code,
            detail=f"Supabase REST error ({resp.status_code}): {resp.text}",
        )

    async def select(
        self, table: str, params: dict[str, str]
    ) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{self._base}/{table}", params=params, headers=self._headers()
            )
        if resp.status_code >= 400:
            self._raise(resp)
        return resp.json()

    async def insert(
        self, table: str, row: dict[str, Any]
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{self._base}/{table}",
                json=row,
                headers=self._headers(prefer="return=representation"),
            )
        if resp.status_code >= 400:
            self._raise(resp)
        data = resp.json()
        if not data:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Insert into {table} returned no row (RLS?).",
            )
        return data[0]

    async def update(
        self, table: str, filters: dict[str, str], patch: dict[str, Any]
    ) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.patch(
                f"{self._base}/{table}",
                params=filters,
                json=patch,
                headers=self._headers(prefer="return=representation"),
            )
        if resp.status_code >= 400:
            self._raise(resp)
        return resp.json()
