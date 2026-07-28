"""AI 스킬 계층 — ReAct 루프 + 스킬 레지스트리 (D109).

바깥에서 쓰는 것은 `get_orchestrator()`와 `catalog.skills_for()` 둘뿐이다.

설계 요지는 세 가지다:
  1. 스킬 하나가 파일 하나. `to_tool_spec()`이 곧 모델에게 가는 도구 스펙이다.
  2. 카탈로그를 **서버가 먼저 좁힌다**(catalog.py). 모델은 좁혀진 목록에서 고른다.
  3. 모든 DB 접근은 호출자 스코프 UserClient — RLS가 최종 방어선이다(D104 불변식).
"""

from __future__ import annotations

from functools import lru_cache

from .base import SkillContext, SkillResult
from .catalog import skills_for
from .orchestrator import Orchestrator, TurnOutcome
from .registry import SkillRegistry
from .skills.concepts import GetConceptSkill, ListSessionConceptsSkill
from .skills.search_class_material import SearchClassMaterialSkill
from .skills.search_textbook_figure import SearchTextbookFigureSkill
from .skills.session_files import ListSessionFilesSkill, ReadSessionFileSkill
from .skills.teacher import (
    ListClassMaterialsSkill,
    SummarizeClassQuestionsSkill,
)
from .skills.think import ThinkSkill

__all__ = [
    "Orchestrator",
    "SkillContext",
    "SkillResult",
    "TurnOutcome",
    "get_orchestrator",
    "skills_for",
]


@lru_cache(maxsize=1)
def get_orchestrator() -> Orchestrator:
    """스킬을 등록한 오케스트레이터(프로세스당 1개).

    스킬은 상태가 없으므로 공유해도 안전하다 — 요청별 상태는 전부 SkillContext에 있다.
    """
    registry = SkillRegistry()
    registry.register(ThinkSkill())
    registry.register(SearchClassMaterialSkill())
    registry.register(SearchTextbookFigureSkill())
    registry.register(ListSessionConceptsSkill())
    registry.register(GetConceptSkill())
    registry.register(ListSessionFilesSkill())
    registry.register(ReadSessionFileSkill())
    registry.register(ListClassMaterialsSkill())
    registry.register(SummarizeClassQuestionsSkill())
    return Orchestrator(registry)
