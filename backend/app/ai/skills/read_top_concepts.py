"""Skill: read_top_concepts — most-used concept tags in a space."""

from __future__ import annotations

from ...services import home
from .base import Skill, SkillContext


async def run(
    *,
    ctx: SkillContext,
    space_kind: str = "personal",
    space_ref: str | None = None,
    limit: int = 8,
    **_: object,
) -> dict:
    # personal space_ref defaults to the caller's own id (mirrors sessions).
    ref = space_ref or (ctx.owner_id if space_kind == "personal" else None)
    if not ref:
        return {"concepts": [], "tokens": 0}
    concepts = await home.get_top_concepts(ctx.client, space_kind, ref, limit)
    return {"concepts": concepts, "tokens": 0}


SKILL = Skill(
    name="read_top_concepts",
    description=(
        "List the caller's most-used concept tags in a space (defaults to the "
        "personal space). Read-only."
    ),
    run=run,
    writes=False,
)
