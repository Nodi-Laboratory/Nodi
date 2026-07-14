"""Service-role Supabase client — WORKER ONLY (RLS bypass).

Uses SUPABASE_SERVICE_ROLE_KEY to read/write past RLS for the background
embedding worker (which has no user JWT). NEVER use this for request-time,
user-facing endpoints — those must keep using the caller's UserClient so RLS
applies. When writing user data here, owner_id is set explicitly to preserve
isolation.

If the service-role key is absent, `get_service_client()` returns None and the
worker stays disabled (the app still boots). No key is ever fabricated.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..config import get_settings

logger = logging.getLogger("nodi.service_client")
settings = get_settings()

# ---------------------------------------------------------------------------
# Shared connection pool (08 refactoring D65, worker side).
#
# Like UserClient, every ServiceClient call used to open a throwaway
# httpx.AsyncClient (fresh TCP+TLS handshake per request). The embedding worker
# fires many of these, so a single module-level keep-alive pool removes the
# repeated handshakes. The shared client carries a default timeout; each method
# still passes its OWN per-call timeout (select 30 / insert 60 / storage 120 …)
# via the request-level `timeout=` override, so behavior is unchanged.
#
# Created lazily on first use (inside the running loop); closed on FastAPI
# shutdown via `aclose_service_http()` (wired in app.main lifespan).
# ---------------------------------------------------------------------------
_SERVICE_LIMITS = httpx.Limits(
    max_connections=50,
    max_keepalive_connections=10,
    keepalive_expiry=30.0,
)

_service_http: httpx.AsyncClient | None = None


def _get_http() -> httpx.AsyncClient:
    """Lazily create / return the process-wide pooled httpx client (worker)."""
    global _service_http
    if _service_http is None or _service_http.is_closed:
        _service_http = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0), limits=_SERVICE_LIMITS
        )
    return _service_http


async def aclose_service_http() -> None:
    """Close the worker's shared pool (FastAPI shutdown). No-op if unused."""
    global _service_http
    if _service_http is not None and not _service_http.is_closed:
        await _service_http.aclose()
    _service_http = None


class ServiceClient:
    """Thin PostgREST + Storage client authenticated with the service role."""

    def __init__(self, key: str):
        self._rest = settings.rest_url
        self._storage = settings.storage_url
        self._key = key

    # --- headers ---------------------------------------------------------
    def _rest_headers(self, prefer: str | None = None) -> dict[str, str]:
        h = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if prefer:
            h["Prefer"] = prefer
        return h

    @staticmethod
    def _raise(resp: httpx.Response, op: str) -> None:
        logger.error("Service %s failed (%s): %s", op, resp.status_code, resp.text)
        resp.raise_for_status()

    # --- PostgREST -------------------------------------------------------
    async def select(self, table: str, params: dict[str, str]) -> list[dict]:
        c = _get_http()
        r = await c.get(
            f"{self._rest}/{table}",
            params=params,
            headers=self._rest_headers(),
            timeout=30.0,
        )
        if r.status_code >= 400:
            self._raise(r, f"select {table}")
        return r.json()

    async def insert(
        self, table: str, rows: dict | list[dict], *, returning: bool = True
    ) -> list[dict]:
        prefer = "return=representation" if returning else "return=minimal"
        c = _get_http()
        r = await c.post(
            f"{self._rest}/{table}",
            json=rows,
            headers=self._rest_headers(prefer=prefer),
            timeout=60.0,
        )
        if r.status_code >= 400:
            self._raise(r, f"insert {table}")
        return r.json() if returning else []

    async def update(
        self, table: str, filters: dict[str, str], patch: dict[str, Any]
    ) -> list[dict]:
        c = _get_http()
        r = await c.patch(
            f"{self._rest}/{table}",
            params=filters,
            json=patch,
            headers=self._rest_headers(prefer="return=representation"),
            timeout=30.0,
        )
        if r.status_code >= 400:
            self._raise(r, f"update {table}")
        return r.json()

    async def count(self, table: str, params: dict[str, str]) -> int:
        """Exact row count for the given filters (via Content-Range header)."""
        headers = self._rest_headers(prefer="count=exact")
        q = {**params, "select": "id", "limit": "1"}
        c = _get_http()
        r = await c.get(
            f"{self._rest}/{table}", params=q, headers=headers, timeout=30.0
        )
        if r.status_code >= 400:
            self._raise(r, f"count {table}")
        cr = r.headers.get("content-range", "")
        # format: "0-0/123" or "*/123"
        if "/" in cr:
            total = cr.rsplit("/", 1)[-1]
            if total.isdigit():
                return int(total)
        return len(r.json())

    async def delete(self, table: str, filters: dict[str, str]) -> list[dict]:
        c = _get_http()
        r = await c.request(
            "DELETE",
            f"{self._rest}/{table}",
            params=filters,
            headers=self._rest_headers(prefer="return=representation"),
            timeout=30.0,
        )
        if r.status_code >= 400:
            self._raise(r, f"delete {table}")
        return r.json()

    async def rpc(self, fn: str, args: dict[str, Any]) -> Any:
        c = _get_http()
        r = await c.post(
            f"{self._rest}/rpc/{fn}",
            json=args,
            headers=self._rest_headers(),
            timeout=30.0,
        )
        if r.status_code >= 400:
            self._raise(r, f"rpc {fn}")
        # void RPC는 PostgREST가 204/빈 본문을 준다 — UserClient.rpc와 동일하게
        # r.json()의 JSONDecodeError를 피해 None으로 처리(별개 클래스라 양쪽 수정).
        if r.status_code == 204 or not r.content:
            return None
        return r.json()

    # --- Storage ---------------------------------------------------------
    async def storage_upload(
        self, bucket: str, path: str, data: bytes, content_type: str
    ) -> None:
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": content_type or "application/octet-stream",
            "x-upsert": "true",
        }
        c = _get_http()
        r = await c.post(
            f"{self._storage}/object/{bucket}/{path}",
            content=data,
            headers=headers,
            timeout=120.0,
        )
        if r.status_code >= 400:
            self._raise(r, f"storage upload {bucket}/{path}")

    async def storage_download(self, bucket: str, path: str) -> bytes:
        headers = {"apikey": self._key, "Authorization": f"Bearer {self._key}"}
        c = _get_http()
        r = await c.get(
            f"{self._storage}/object/{bucket}/{path}",
            headers=headers,
            timeout=120.0,
        )
        if r.status_code >= 400:
            self._raise(r, f"storage download {bucket}/{path}")
        return r.content

    async def storage_delete(self, bucket: str, path: str) -> None:
        headers = {"apikey": self._key, "Authorization": f"Bearer {self._key}"}
        c = _get_http()
        r = await c.request(
            "DELETE",
            f"{self._storage}/object/{bucket}/{path}",
            headers=headers,
            timeout=60.0,
        )
        # 404 is fine (already gone); only raise on other errors.
        if r.status_code >= 400 and r.status_code != 404:
            self._raise(r, f"storage delete {bucket}/{path}")


_client: ServiceClient | None = None
_checked = False


def get_service_client() -> ServiceClient | None:
    """Return the singleton service client, or None if no service-role key."""
    global _client, _checked
    if _checked:
        return _client
    _checked = True
    key = settings.supabase_service_role_key
    if not key:
        logger.warning(
            "SUPABASE_SERVICE_ROLE_KEY is empty — embedding worker and file "
            "uploads are DISABLED. Set it in the root .env to enable."
        )
        _client = None
    else:
        _client = ServiceClient(key)
    return _client


def service_available() -> bool:
    return get_service_client() is not None
