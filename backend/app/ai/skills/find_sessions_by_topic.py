"""Skill: find_sessions_by_topic — sessions/tags matching a topic string."""

from __future__ import annotations

from ...services import home
from .base import Skill, SkillContext


async def run(
    *, ctx: SkillContext, query: str = "", limit: int = 5, **_: object
) -> dict:
    result = await home.find_sessions_by_topic(ctx.client, query, limit)
    result["tokens"] = 0
    return result


SKILL = Skill(
    name="find_sessions_by_topic",
    description=(
        "Search the caller's sessions (by title) and concept tags (by name) for "
        "a topic string. Read-only."
    ),
    run=run,
    writes=False,
)
