"""Skill: read_recent_sessions — recently active sessions (optionally scoped)."""

from __future__ import annotations

from ...services import home
from .base import Skill, SkillContext


async def run(
    *,
    ctx: SkillContext,
    space_kind: str | None = None,
    space_ref: str | None = None,
    limit: int = 8,
    **_: object,
) -> dict:
    sessions = await home.get_recent_sessions(
        ctx.client, space_kind, space_ref, limit
    )
    return {"sessions": sessions, "tokens": 0}


SKILL = Skill(
    name="read_recent_sessions",
    description=(
        "List the caller's most recently active sessions, optionally scoped to "
        "a space (space_kind/space_ref). Read-only."
    ),
    run=run,
    writes=False,
)
