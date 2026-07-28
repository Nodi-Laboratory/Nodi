"""계획 수립 스킬 — 데이터를 건드리지 않는다 (D109)."""

from __future__ import annotations

from typing import Any

from ..base import SkillBase, SkillContext, SkillResult


class ThinkSkill(SkillBase):
    name = "think"
    description = (
        "여러 도구를 순서대로 써야 하는 복잡한 질문에서, 먼저 계획을 정리한다. "
        "데이터를 조회하거나 변경하지 않는다. 어떤 도구를 어떤 순서로 쓸지 "
        "정해야 할 때만 호출하고, 단순한 질문에는 쓰지 마라."
    )
    parameters = {
        "type": "object",
        "properties": {
            "reasoning": {
                "type": "string",
                "description": "무엇을 어떤 순서로 할지와 그 이유",
            }
        },
        "required": ["reasoning"],
    }

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        reasoning = (args.get("reasoning") or "").strip()
        return SkillResult(
            ok=True,
            message="계획을 정리했습니다.",
            data={"reasoning": reasoning},
        )
