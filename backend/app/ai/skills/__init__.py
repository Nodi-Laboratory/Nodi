"""Skill registry — auto-collects every `SKILL` in this package.

Usage:
    from app.ai.skills import SKILLS, get_skill, catalog
"""

from __future__ import annotations

import importlib
import logging
import pkgutil

from .base import Skill

logger = logging.getLogger("nodi.ai.skills")

SKILLS: dict[str, Skill] = {}


def _discover() -> None:
    """Import every submodule and register its module-level `SKILL`."""
    for mod in pkgutil.iter_modules(__path__):
        if mod.name in ("base",) or mod.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{__name__}.{mod.name}")
        except Exception:  # noqa: BLE001 - one bad skill must not break others
            logger.exception("Failed to import skill module %s", mod.name)
            continue
        skill = getattr(module, "SKILL", None)
        if isinstance(skill, Skill):
            SKILLS[skill.name] = skill
        else:
            logger.warning("Module %s has no module-level SKILL", mod.name)


_discover()


def get_skill(name: str) -> Skill | None:
    return SKILLS.get(name)


def catalog() -> str:
    """Render the skill catalog for prompt injection (name: description)."""
    if not SKILLS:
        return "(no skills registered)"
    return "\n".join(f"- {s.name}: {s.description}" for s in SKILLS.values())
