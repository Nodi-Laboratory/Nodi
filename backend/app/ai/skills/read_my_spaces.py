"""Skill: read_my_spaces — the caller's personal space + joined classes."""

from __future__ import annotations

from ...services import home
from .base import Skill, SkillContext


async def run(*, ctx: SkillContext, **_: object) -> dict:
    spaces = await home.get_my_spaces(ctx.client, ctx.owner_id)
    return {"spaces": spaces, "tokens": 0}


SKILL = Skill(
    name="read_my_spaces",
    description="List the caller's spaces (personal + joined classes). Read-only.",
    run=run,
    writes=False,
)
