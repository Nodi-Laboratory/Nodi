"""D109 — 스킬 레지스트리 · 카탈로그 · ReAct 루프.

핵심 계약 셋을 고정한다:
  1. **카탈로그가 스코프로 좁혀진다** — 개인 세션에 학급 도구가 보이면 안 된다.
  2. **스킬 실패가 턴을 죽이지 않는다** — 예외는 SkillResult(ok=False)로 변환.
  3. **도구를 안 부르면 생성으로 직행** — 인사에 검색이 나가지 않는다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.ai import catalog, skills_for
from app.ai.base import SkillBase, SkillContext, SkillResult
from app.ai.orchestrator import Orchestrator
from app.ai.registry import SkillRegistry


def _ctx(space_kind: str = "class", role: str = "student") -> SkillContext:
    return SkillContext(
        user_id="u1",
        client=object(),  # 스킬을 부르지 않는 테스트에서는 쓰이지 않는다
        session_id="s1",
        space_kind=space_kind,
        space_ref="c1",
        role=role,
    )


class _Echo(SkillBase):
    name = "echo"
    description = "테스트용"
    parameters = {"type": "object", "properties": {}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        return SkillResult(ok=True, message="ok", data={"args": args})


class _Boom(SkillBase):
    name = "boom"
    description = "테스트용 실패"
    parameters = {"type": "object", "properties": {}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        raise RuntimeError("의도된 폭발")


# --- 카탈로그 (층 1) -------------------------------------------------------


def test_개인세션에는_도구가_없다():
    """개인 공간엔 학급 자료도 교과서도 없다 — 부를 도구 자체가 없다."""
    assert skills_for("personal", "student") == []


def test_도구가_부족하면_계획_도구도_빼는다():
    """think는 순서를 정할 대상이 2개 이상일 때만 의미가 있다.

    실측(2026-07-28): 실도구 0개인 개인 세션에 think만 노출했더니 모델이 그걸
    불렀다. 계획을 세울 대상이 없는데 계획만 세우고 왕복 한 번을 버린 셈이다.
    """
    assert "think" not in skills_for("personal", "student")
    assert "think" in skills_for("class", "student")


def test_학급세션에는_학급_도구가_보인다():
    names = skills_for("class", "student")
    assert "search_class_material" in names
    assert "search_textbook_figure" in names


def test_교사도_학생과_같은_도구를_본다_아직은():
    # 교사 전용 스킬은 아직 없다. 생기면 이 테스트가 실패하며 알려 준다.
    assert skills_for("class", "teacher") == skills_for("class", "student")


def test_카탈로그_상수에_중복이_없다():
    assert len(catalog._CLASS_ONLY) == len(set(catalog._CLASS_ONLY))
    assert catalog._PLANNER not in catalog._CLASS_ONLY


# --- 레지스트리 ------------------------------------------------------------


def test_이름_중복_등록은_거부한다():
    r = SkillRegistry()
    r.register(_Echo())
    with pytest.raises(ValueError, match="중복"):
        r.register(_Echo())


def test_카탈로그는_요청한_이름만_담는다():
    r = SkillRegistry()
    r.register(_Echo())
    r.register(_Boom())
    specs = r.catalog(["echo", "없는스킬"])
    assert [s["function"]["name"] for s in specs] == ["echo"]


def test_tool_spec은_openai_형식이다():
    spec = _Echo().to_tool_spec()
    assert spec["type"] == "function"
    assert spec["function"]["name"] == "echo"
    assert "parameters" in spec["function"]


async def test_스킬_예외는_결과로_변환된다():
    """스킬 하나가 죽어도 턴은 살아야 한다 — RAG 불변식의 스킬판."""
    r = SkillRegistry()
    r.register(_Boom())
    res = await r.dispatch("boom", {}, _ctx())
    assert res.ok is False
    assert res.error_code == "internal"
    assert "의도된 폭발" in res.message


async def test_없는_스킬은_모델에게_알려준다():
    # 조용히 무시하면 모델이 같은 이름을 계속 부른다.
    res = await SkillRegistry().dispatch("유령", {}, _ctx())
    assert res.ok is False
    assert res.error_code == "not_found"
    assert "유령" in res.message


# --- ReAct 루프 ------------------------------------------------------------


async def _drain(orch, **kw):
    kinds, tokens, outcome = [], [], None
    async for kind, payload in orch.run(**kw):
        kinds.append(kind)
        if kind == "token":
            tokens.append(payload)
        elif kind == "outcome":
            outcome = payload
    return kinds, "".join(tokens), outcome


def _patch_llm(monkeypatch, *, tool_calls_sequence, stream_text="답변"):
    """solar.complete/stream_answer를 대역으로 교체하고 호출 기록을 돌려준다."""
    from app.ai import orchestrator as O

    calls: dict[str, Any] = {"complete": 0, "stream": 0, "tools_seen": []}
    seq = list(tool_calls_sequence)

    async def fake_complete(messages, *, tools=None, max_tokens=None):
        calls["complete"] += 1
        calls["tools_seen"].append([t["function"]["name"] for t in (tools or [])])
        tc = seq.pop(0) if seq else None
        return {"role": "assistant", "content": "", "tool_calls": tc}

    async def fake_stream(history, question, system):
        calls["stream"] += 1
        calls["system"] = system
        for ch in stream_text:
            yield ch

    monkeypatch.setattr(O.solar, "complete", fake_complete)
    monkeypatch.setattr(O.solar, "stream_answer", fake_stream)
    return calls


async def test_도구를_안_부르면_바로_생성한다(monkeypatch):
    """인사 턴 — 판단 1회 후 검색 없이 스트리밍으로 넘어간다."""
    calls = _patch_llm(monkeypatch, tool_calls_sequence=[None], stream_text="안녕!")
    r = SkillRegistry()
    r.register(_Echo())
    kinds, text, outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="안녕",
        history=[],
        tool_names=["echo"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert calls["complete"] == 1
    assert calls["stream"] == 1
    assert text == "안녕!"
    assert outcome.used_skills == []          # 스킬이 하나도 안 돌았다
    assert "tool_call" not in " ".join(kinds)


async def test_도구를_부르면_실행하고_결과를_되돌린다(monkeypatch):
    tc = [{"id": "c1", "type": "function",
           "function": {"name": "echo", "arguments": '{"q":"광합성"}'}}]
    calls = _patch_llm(monkeypatch, tool_calls_sequence=[tc, None])
    r = SkillRegistry()
    r.register(_Echo())
    kinds, _, outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="광합성 자료 찾아줘",
        history=[],
        tool_names=["echo"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert outcome.used_skills == ["echo"]
    assert calls["complete"] == 2   # 판단 → 결과 반영 후 재판단
    assert calls["stream"] == 1     # 생성은 마지막 1회
    assert kinds.count("sse") == 2  # tool_call + tool_result


async def test_생성_단계에는_도구를_주지_않는다(monkeypatch):
    """형식과 도구 지시의 충돌을 시점으로 분리한다 — 생성은 tools 없이."""
    calls = _patch_llm(monkeypatch, tool_calls_sequence=[None])
    r = SkillRegistry()
    r.register(_Echo())
    await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="안녕",
        history=[],
        tool_names=["echo"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    # 판단 호출에는 도구가 실렸고, 생성은 stream_answer라 도구 자체가 없다.
    assert calls["tools_seen"] == [["echo"]]


async def test_스텝_상한을_넘지_않는다(monkeypatch):
    """모델이 계속 도구를 불러도 무한 루프에 빠지지 않는다."""
    tc = [{"id": "c", "type": "function",
           "function": {"name": "echo", "arguments": "{}"}}]
    calls = _patch_llm(monkeypatch, tool_calls_sequence=[tc] * 10)
    r = SkillRegistry()
    r.register(_Echo())
    _, _, outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["echo"],
        answer_system_prompt="BASE",
        max_steps=2,
    )
    assert calls["complete"] == 2
    assert len(outcome.used_skills) == 2
    assert calls["stream"] == 1  # 상한에 걸려도 답변은 생성한다


async def test_판단_호출이_실패해도_답변은_나온다(monkeypatch):
    """도구 판단 단계의 장애가 채팅을 막지 않는다."""
    from app.ai import orchestrator as O

    async def boom(*a, **k):
        raise RuntimeError("upstream 503")

    async def fake_stream(history, question, system):
        yield "그래도 답한다"

    monkeypatch.setattr(O.solar, "complete", boom)
    monkeypatch.setattr(O.solar, "stream_answer", fake_stream)
    r = SkillRegistry()
    r.register(_Echo())
    _, text, outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["echo"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert text == "그래도 답한다"
    assert outcome.used_skills == []


async def test_카탈로그가_비면_판단_호출을_생략한다(monkeypatch):
    """도구가 하나도 없으면 판단 단계 자체가 낭비다."""
    calls = _patch_llm(monkeypatch, tool_calls_sequence=[None])
    _, _, _ = await _drain(
        Orchestrator(SkillRegistry()),
        ctx=_ctx("personal"),
        question="안녕",
        history=[],
        tool_names=[],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert calls["complete"] == 0
    assert calls["stream"] == 1


async def test_찾은_근거가_생성_프롬프트에_붙는다(monkeypatch):
    class _Rag(SkillBase):
        name = "rag"
        description = "d"
        parameters = {"type": "object", "properties": {}}

        async def run(self, args, ctx):
            return SkillResult(
                ok=True, message="ok",
                data={"sources": [{"name": "과학.pdf", "snippet": "엽록체에서 일어난다"}]},
            )

    tc = [{"id": "c", "type": "function",
           "function": {"name": "rag", "arguments": "{}"}}]
    calls = _patch_llm(monkeypatch, tool_calls_sequence=[tc, None])
    r = SkillRegistry()
    r.register(_Rag())
    _, _, outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["rag"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert "엽록체에서 일어난다" in calls["system"]
    assert calls["system"].startswith("BASE")
    assert outcome.rag_sources[0]["name"] == "과학.pdf"


async def test_같은_도판은_한_번만_모은다(monkeypatch):
    class _Fig(SkillBase):
        name = "fig"
        description = "d"
        parameters = {"type": "object", "properties": {}}

        async def run(self, args, ctx):
            return SkillResult(
                ok=True, message="ok",
                data={"figures": [
                    {"figure_id": "f1", "file_id": "x", "caption": "그림1"},
                    {"figure_id": "f1", "file_id": "x", "caption": "그림1"},
                ]},
            )

    tc = [{"id": "c", "type": "function",
           "function": {"name": "fig", "arguments": "{}"}}]
    _patch_llm(monkeypatch, tool_calls_sequence=[tc, None])
    r = SkillRegistry()
    r.register(_Fig())
    _, _, outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["fig"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert len(outcome.figures) == 1


async def test_깨진_인자_JSON도_턴을_죽이지_않는다(monkeypatch):
    tc = [{"id": "c", "type": "function",
           "function": {"name": "echo", "arguments": "{망가진"}}]
    _patch_llm(monkeypatch, tool_calls_sequence=[tc, None])
    r = SkillRegistry()
    r.register(_Echo())
    _, _, outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["echo"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    # 빈 인자로 실행된다 — 파싱 실패로 턴 전체가 죽는 것보다 낫다.
    assert outcome.used_skills == ["echo"]
