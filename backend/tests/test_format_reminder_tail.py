"""형식 지시는 프롬프트의 **마지막 말**이어야 한다 (사용자 보고 2026-08-12).

사용자 물음: "형식이 갑자기 틀리는 이유가 뭐야? 됐다가 안 됐다가를 반복한다."

출력 형식(`CHAT:` → `@concept:` → `@end`)은 `system_base` 안에 있고 그 자리는
프롬프트의 **맨 앞**이다. 그 뒤로 세션 파일·태그·대화 트리·펜 표시·자료·도구
결과가 줄줄이 붙는데, 하나같이 명령문으로 끝난다("…활용하세요", "…없는 내용을
지어내지 마세요", "비어 있으면 없다고 솔직히 말하세요"). 모델이 **마지막으로
읽는 것이 내용 지시**라 형식은 그만큼 멀어진다.

꼬리의 길이는 턴마다 다르다 — 카드가 쌓인 방일수록 tree_guide가 길고, 자료를
찾은 턴일수록 rag·근거 블록이 길다. **그래서 됐다 안 됐다 한다.** 이 파일은
"어떤 블록이 붙든 형식이 맨 끝에 온다"를 못 박는다.
"""

from typing import Any

import pytest

from app.ai.base import SkillBase, SkillContext, SkillResult
from app.ai.orchestrator import Orchestrator
from app.ai.registry import SkillRegistry
from app.services import gemini, solar


def test_블록이_다_붙어도_형식이_맨_끝이다() -> None:
    prompt, blocks = gemini.compose_system_structured(
        "자료 청크",
        session_file_context="학생이 올린 파일 전문",
        tag_context="지구과학, 생명과학",
        tree_context="## [지구과학]\n- 지진",
        ink_context="화살표가 [카드 1]을 가리킨다.",
        base_instruction="기본 지시",
        format_reminder=solar.FORMAT_REMINDER,
    )
    assert prompt.endswith(solar.FORMAT_REMINDER)
    assert blocks[-1]["kind"] == "format_reminder"


def test_강조_구간이_실제_프롬프트와_맞는다() -> None:
    """⚠️ 문자열만 늘리고 블록을 안 넣으면 관리자 화면이 조용히 거짓말을 한다.

    강조는 `prompt_span`으로 그려진다(D35) — 프롬프트와 span은 한 곳에서
    같이 나와야 한다.
    """
    prompt, blocks = gemini.compose_system_structured(
        tree_context="## [지구과학]\n- 지진",
        base_instruction="기본 지시",
        format_reminder="형식을 지켜라",
    )
    for b in blocks:
        start, end = b["prompt_span"]
        assert prompt[start:end], f"{b['kind']} 구간이 비었다"
    start, end = blocks[-1]["prompt_span"]
    assert prompt[start:end] == "형식을 지켜라"


def test_안_주면_안_붙는다() -> None:
    prompt, blocks = gemini.compose_system_structured(base_instruction="기본 지시")
    assert prompt == "기본 지시"
    assert [b["kind"] for b in blocks] == ["system_base"]


# ── 근거 블록 뒤에서도 마지막이어야 한다 ─────────────────────────────────


class _자료(SkillBase):
    name = "search_class_material"
    description = "수업 자료 검색"
    parameters: dict[str, Any] = {"type": "object", "properties": {}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        return SkillResult(
            ok=True,
            message="1개",
            data={"sources": [{"name": "교과서", "snippet": "판이 어긋난다"}]},
        )


@pytest.mark.asyncio
async def test_근거_블록_뒤에도_형식이_마지막이다(monkeypatch) -> None:
    """근거 블록은 프롬프트를 만든 쪽의 꼬리 **뒤에** 쌓인다.

    그러면 꼬리에 넣어 둔 되새김이 도로 묻힌다 — 게다가 근거 블록은 대화체를
    부추기는 문장으로 끝난다("비어 있으면 없다고 솔직히 말하세요"). 형식이
    깨진 답이 하필 자료를 많이 찾은 턴에서 났다.
    """
    from app.ai import orchestrator as O

    async def fake_complete(messages, *, tools=None, max_tokens=None):
        return O.solar.Completion(
            message={
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "1",
                        "type": "function",
                        "function": {"name": "search_class_material", "arguments": "{}"},
                    }
                ],
            },
            usage={"prompt": 1, "completion": 1, "total": 2, "cached": 0},
        )

    async def fake_stream(history, question, system, *, usage_sink=None, **_):
        yield "@concept: 지진|지구과학\n판이 어긋나요."

    monkeypatch.setattr(O.solar, "complete", fake_complete)
    monkeypatch.setattr(O.solar, "stream_answer", fake_stream)

    registry = SkillRegistry()
    registry.register(_자료())
    ctx = SkillContext(
        user_id="u1", client=object(), session_id="s1",
        space_kind="class", space_ref="c1", role="student",
    )

    outcome = None
    async for kind, payload in Orchestrator(registry).run(
        ctx=ctx,
        question="지진이 뭐야?",
        history=[],
        tool_names=["search_class_material"],
        answer_system_prompt="기본 지시\n\n" + solar.FORMAT_REMINDER,
        max_steps=2,
    ):
        if kind == "outcome":
            outcome = payload

    assert outcome is not None
    # 근거가 실제로 붙었는지부터 확인한다 — 안 붙었으면 이 테스트는 아무것도
    # 지키지 않으면서 통과한다.
    assert "판이 어긋난다" in outcome.final_system
    assert outcome.final_system.rstrip().endswith(solar.FORMAT_REMINDER)
