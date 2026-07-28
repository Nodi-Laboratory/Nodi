"""스킬의 계약 — SkillBase · SkillResult · SkillContext (D109).

스킬 하나가 파일 하나다. `to_tool_spec()`이 곧 모델에게 보내는 도구 스펙이므로,
스킬을 추가하는 일이 파일을 추가하는 일로 끝난다.

**모든 DB 접근은 `ctx.client`(호출자 스코프 UserClient)로 한다.** 스킬이
service-role 클라이언트를 잡으면 RLS를 우회하게 되고, 그 순간 "권한은 DB가
강제한다"는 불변식(D104)이 깨진다. 스킬은 사용자의 권한을 넘겨받아 도는 코드이지
권한을 새로 얻는 코드가 아니다.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from ..db.client import UserClient


@dataclass
class SkillResult:
    """스킬 실행 결과.

    `data`가 모델에게 tool_result로 돌아간다 — 여기 담기는 양이 곧 다음 LLM
    호출의 입력 크기다. 큰 본문을 통째로 넣지 말고 필요한 만큼만 담는다.
    """

    ok: bool
    message: str
    data: dict[str, Any] = field(default_factory=dict)
    error_code: str = ""


@dataclass
class SkillContext:
    """스킬 실행에 필요한 호출자 정보.

    Plant-Counselor는 서비스 객체들을 컨텍스트에 담지만, Nodi는 서비스가 전부
    모듈 함수라 클라이언트와 스코프만 있으면 된다.
    """

    user_id: str
    client: UserClient  # RLS 스코프 — 모든 DB 접근은 이걸로
    session_id: str
    space_kind: str  # personal | class
    space_ref: str | None
    role: str  # student | teacher | admin


class SkillBase(ABC):
    """스킬 인터페이스.

    `parameters`는 JSON Schema다. 모델이 이 스키마대로 인자를 만들어 주므로
    설명을 성실히 쓸수록 호출 품질이 올라간다 — description이 곧 프롬프트다.
    """

    name: str = ""
    description: str = ""
    parameters: dict[str, Any] = {}

    @abstractmethod
    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        """스킬 본체. 예외를 던져도 레지스트리가 SkillResult로 변환한다."""

    def to_tool_spec(self) -> dict[str, Any]:
        """OpenAI 호환 tool 스펙."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }
