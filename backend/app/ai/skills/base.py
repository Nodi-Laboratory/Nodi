"""Skill contract: one capability = one file (architecture §7).

A skill module exposes a module-level `SKILL: Skill`. The registry
(`skills/__init__.py`) auto-discovers every submodule and collects them, so
adding a capability is just dropping a new file in this package.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ...services.supabase_client import UserClient


@dataclass(frozen=True)
class SkillContext:
    """Runtime context handed to a skill (not part of the traced input).

    Carries the caller's RLS-scoped client and identity so read-skills can query
    the caller's own data. Kept out of the ai_steps trace (no client/token in
    the trace payload).
    """

    client: "UserClient"
    owner_id: str


# A skill receives a SkillContext (ctx=) plus typed kwargs and returns a
# JSON-serializable observation.
SkillRun = Callable[..., Awaitable[Any]]


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    run: SkillRun
    # True for skills that mutate state (require confirmation_required gate in
    # later stages). Navigator question generation is read-only.
    writes: bool = False
