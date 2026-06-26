"""Skill contract: one capability = one file (architecture §7).

A skill module exposes a module-level `SKILL: Skill`. The registry
(`skills/__init__.py`) auto-discovers every submodule and collects them, so
adding a capability is just dropping a new file in this package.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

# A skill receives a context dict (caller, models, etc.) plus typed kwargs and
# returns a JSON-serializable observation.
SkillRun = Callable[..., Awaitable[Any]]


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    run: SkillRun
    # True for skills that mutate state (require confirmation_required gate in
    # later stages). Navigator question generation is read-only.
    writes: bool = False
