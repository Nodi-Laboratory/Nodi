"""Admin console endpoints (Stage 4c) — all admin-only.

Uses the admin's OWN JWT against the admin RLS policies / SECURITY DEFINER RPCs
added in migration 0008 (no service_role). Job monitor + file/storage usage are
deferred to Stage 3b.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, Profile, get_current_user, require_admin
from ..services.supabase_client import UserClient

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
    """Upsert one runtime setting. NOTE: editing here updates app_settings only;
    runtime wiring (live effect) is a follow-up (see report)."""
    client = UserClient.from_user(user)
    return await client.upsert(
        "app_settings",
        {
            "key": key,
            "value": body.value,
            "updated_by": user.id,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="key",
    )


# ---------------------------------------------------------------------------
# Usage (partial — see note)
# ---------------------------------------------------------------------------
@router.get("/usage")
async def token_usage(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Per-user token totals.

    PARTIAL: ai_steps.tokens currently covers only ReAct skill steps (navigator
    / overseer). Chat and tagging token usage is not yet logged. Storage /
    embedding usage arrives with files (Stage 3b).
    """
    client = UserClient.from_user(user)
    rows = await client.rpc("admin_token_usage", {})
    return {
        "partial": True,
        "note": "Only ReAct skill-step tokens are counted; chat/tagging tokens "
        "are not yet logged. Storage/embedding usage pending Stage 3b.",
        "by_user": rows if isinstance(rows, list) else [],
    }


# ---------------------------------------------------------------------------
# Logs — chat turn browser (ai_logs, D25) + ReAct step traces (ai_sessions)
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


@router.get("/traces")
async def list_traces(
    user_id: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """ReAct step traces (`ai_sessions` + embedded `ai_steps`) for
    navigator/overseer runs. Shown alongside a turn's detail."""
    client = UserClient.from_user(user)
    params: dict[str, str] = {
        "select": (
            "id,owner_id,session_id,kind,created_at,"
            "ai_steps(seq,thought,skill,input,observation,tokens,created_at)"
        ),
        "order": "created_at.desc",
        "ai_steps.order": "seq.asc",
        "limit": str(limit),
        "offset": str(offset),
    }
    if user_id:
        params["owner_id"] = f"eq.{user_id}"
    sessions = await client.select("ai_sessions", params)
    return {"limit": limit, "offset": offset, "sessions": sessions}
