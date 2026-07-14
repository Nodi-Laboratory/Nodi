"""Home dashboard data queries.

Plain, read-only, RLS-scoped queries used by the `/home/*` router. No LLM here.
"""

from __future__ import annotations

from typing import Any

from .supabase_client import UserClient


async def get_my_spaces(
    client: UserClient, owner_id: str
) -> list[dict[str, Any]]:
    """Personal space + joined classes, as logical spaces."""
    spaces: list[dict[str, Any]] = [
        {
            "space_kind": "personal",
            "space_ref": owner_id,
            "name": "개인 공간",
            "role_in_class": None,
        }
    ]
    rows = await client.select(
        "class_members",
        {
            "user_id": f"eq.{owner_id}",
            "select": "class_id,role_in_class,classes(id,name)",
        },
    )
    for r in rows:
        cls = r.get("classes") or {}
        if not isinstance(cls, dict) or not cls.get("id"):
            continue
        spaces.append(
            {
                "space_kind": "class",
                "space_ref": cls["id"],
                "name": cls.get("name") or "학급",
                "role_in_class": r.get("role_in_class"),
            }
        )
    return spaces


async def get_recent_sessions(
    client: UserClient,
    space_kind: str | None = None,
    space_ref: str | None = None,
    limit: int = 8,
) -> list[dict[str, Any]]:
    """Most-recently-updated sessions, optionally scoped to one space."""
    params: dict[str, str] = {
        "select": "id,title,emoji,space_kind,space_ref,updated_at",
        "order": "updated_at.desc",
        "limit": str(limit),
    }
    if space_kind:
        params["space_kind"] = f"eq.{space_kind}"
    if space_ref:
        params["space_ref"] = f"eq.{space_ref}"
    return await client.select("sessions", params)
