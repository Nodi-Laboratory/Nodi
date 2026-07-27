"""Admin console endpoints (Stage 4c) — all admin-only.

Uses the admin's OWN JWT against the admin RLS policies / SECURITY DEFINER RPCs
added in migration 0008 (no service_role). Job monitor + file/storage usage are
deferred to Stage 3b.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, Profile, get_current_user, require_admin
from ..db.client import UserClient
from ..services import app_settings

router = APIRouter(prefix="/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Users + roles
# ---------------------------------------------------------------------------
@router.get("/users")
async def list_users(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await client.select(
        "profiles",
        {
            "select": "id,email,role,display_name,avatar_url,created_at",
            "order": "created_at.desc",
        },
    )


class RoleBody(BaseModel):
    role: str = Field(pattern="^(student|teacher|admin)$")


@router.post("/users/{user_id}/role")
async def set_user_role(
    user_id: str,
    body: RoleBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Change a user's app role. Self-demotion is blocked inside the RPC."""
    client = UserClient.from_user(user)
    result = await client.rpc(
        "admin_set_user_role",
        {"p_user_id": user_id, "p_role": body.role},
    )
    if isinstance(result, list):
        return result[0] if result else {}
    return result


# ---------------------------------------------------------------------------
# Runtime settings (app_settings)
# ---------------------------------------------------------------------------
@router.get("/settings")
async def list_settings(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await client.select(
        "app_settings",
        {"select": "key,value,updated_at,updated_by", "order": "key.asc"},
    )


class SettingBody(BaseModel):
    # jsonb value — any JSON type (str/number/bool/object/array).
    value: Any


@router.put("/settings/{key}")
async def put_setting(
    key: str,
    body: SettingBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Upsert one runtime setting and invalidate the overlay cache (D62).

    The value lands in app_settings AND, because every tunable call site now
    reads through the app_settings overlay (services/app_settings.py), takes
    LIVE effect — instantly in this process via bust_cache(), within the TTL
    elsewhere. (new-only 키는 신규 잡부터 적용된다 — 워커의 청킹 파라미터 등.)
    """
    client = UserClient.from_user(user)
    result = await client.upsert(
        "app_settings",
        {
            "key": key,
            "value": body.value,
            "updated_by": user.id,
            "updated_at": datetime.now(UTC).isoformat(),
        },
        on_conflict="key",
    )
    app_settings.bust_cache()
    return result


# ---------------------------------------------------------------------------
# Logs — chat turn browser (ai_logs, D25)
# ---------------------------------------------------------------------------
@router.get("/logs")
async def list_logs(
    user_id: str | None = Query(None),
    since: str | None = Query(None, description="ISO timestamp (created_at >=)"),
    until: str | None = Query(None, description="ISO timestamp (created_at <)"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Chat turn logs (`ai_logs`): system prompt, Q/A, used contexts, skill
    calls, errors, token estimate. user/date filters + pagination, newest first.
    The frontend live-appends new turns via Supabase Realtime and pages history
    through this endpoint."""
    client = UserClient.from_user(user)
    params: dict[str, str] = {
        "select": (
            "id,owner_id,session_id,node_id,kind,system_prompt,question,answer,"
            "contexts,skill_calls,errors,token_estimate,created_at"
        ),
        "order": "created_at.desc",
        "limit": str(limit),
        "offset": str(offset),
    }
    if user_id:
        params["owner_id"] = f"eq.{user_id}"
    if since:
        params["created_at"] = f"gte.{since}"
    if until:
        # combine with `since` when both present
        params["and"] = f"(created_at.lt.{until})"
    logs = await client.select("ai_logs", params)
    return {"limit": limit, "offset": offset, "logs": logs}


_LOG_SELECT = (
    "id,owner_id,session_id,node_id,kind,system_prompt,question,answer,"
    "contexts,skill_calls,errors,token_estimate,created_at"
)


@router.get("/logs/{log_id}")
async def get_log_detail(
    log_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """D34 turn detail: one `ai_logs` turn (structured contexts incl. RAG
    sources + prompt spans), so the admin sees how a turn was built. Admin-only
    (require_admin + admin RLS)."""
    client = UserClient.from_user(user)
    rows = await client.select(
        "ai_logs",
        {"id": f"eq.{log_id}", "select": _LOG_SELECT, "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Log not found."
        )
    return {"log": rows[0]}

