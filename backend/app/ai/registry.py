"""스킬 레지스트리 — 등록 · 카탈로그 · dispatch (D109).

`dispatch`는 **어떤 예외도 밖으로 내보내지 않는다.** 스킬 하나가 죽어도 채팅
턴은 살아야 한다 — "RAG는 채팅을 절대 막지 않는다"(CLAUDE.md 불변식)를 스킬
계층으로 확장한 것이다. 실패는 `SkillResult(ok=False)`로 모델에게 전달되고,
모델이 다른 도구를 고르거나 아는 선에서 답하도록 둔다.
"""

from __future__ import annotations

import logging
from typing import Any

from .base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("nodi.ai.registry")


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, SkillBase] = {}

    def register(self, skill: SkillBase) -> None:
        if not skill.name:
            raise ValueError(f"이름 없는 스킬은 등록할 수 없다: {skill!r}")
        if skill.name in self._skills:
            raise ValueError(f"스킬 이름 중복: {skill.name}")
        self._skills[skill.name] = skill

    def get(self, name: str) -> SkillBase | None:
        return self._skills.get(name)

    def names(self) -> list[str]:
        return list(self._skills)

    def catalog(self, names: list[str]) -> list[dict[str, Any]]:
        """주어진 이름들만 tool 스펙으로. 모르는 이름은 조용히 건너뛴다.

        카탈로그를 좁히는 판단은 `catalog.py`가 하고 여기서는 조립만 한다.
        """
        return [self._skills[n].to_tool_spec() for n in names if n in self._skills]

    async def dispatch(
        self, name: str, args: dict[str, Any], ctx: SkillContext
    ) -> SkillResult:
        skill = self.get(name)
        if skill is None:
            # 모델이 없는 도구 이름을 지어내는 일이 실제로 있다. 조용히 무시하면
            # 모델이 같은 이름을 계속 부르므로, 없다는 사실을 그대로 알려준다.
            return SkillResult(
                ok=False,
                message=f"'{name}' 스킬은 없습니다. 사용 가능한 도구 중에서 고르세요.",
                error_code="not_found",
            )
        try:
            return await skill.run(args or {}, ctx)
        except Exception as exc:  # noqa: BLE001 - 스킬 실패가 턴을 죽이지 않는다
            logger.exception("스킬 실패: %s args=%s", name, args)
            return SkillResult(
                ok=False,
                message=f"'{name}' 실행 중 문제가 생겼습니다: {exc}",
                error_code="internal",
            )
