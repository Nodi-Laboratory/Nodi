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


def test_개인세션에는_학급_도구가_없다():
    """개인 공간엔 학급 자료도 교과서도 없다 — 노출하면 헛물을 켠다."""
    names = skills_for("personal", "student", has_concepts=True)
    assert "search_class_material" not in names
    assert "search_textbook_figure" not in names
    # 개념 조회는 개인 세션에도 있다(개인 공간에서도 카드를 만든다).
    assert "get_concept" in names


def test_빈_세션에는_도구를_하나도_주지_않는다():
    """첫 질문 — 카드도 파일도 없다. 부를 게 없으면 카탈로그도 비어야 한다.

    빈 도구를 보여주면 모델이 부르고, 빈 결과를 받고, 묻지도 않은 얘기를
    답에 붙인다(think가 도구 0개 세션에서 헛돌던 것과 같은 낭비).
    """
    assert skills_for("personal", "student") == []


def test_개념이_생기면_개념_스킬이_열린다():
    assert "get_concept" not in skills_for("class", "student")
    assert "get_concept" in skills_for("class", "student", has_concepts=True)


def test_개인세션_개념_카드에는_계획_도구가_안_붙는다():
    """D216. 개념 스킬이 둘이던 시절에는 그 둘만으로 `think`가 딸려 나왔다.

    목록 스킬을 걷어내 실도구가 하나가 되면서 그 낭비도 사라진다 — 순서를
    정할 것이 없는데 순서를 정하던 왕복이다(`_PLANNER` 주석의 그 문제).
    """
    names = skills_for("personal", "student", has_concepts=True)
    assert "think" not in names


def test_세션_파일_스킬은_파일이_있을_때만_보인다():
    """없는데 노출하면 모델이 부르고 빈 목록을 받아 군더더기를 답에 붙인다."""
    without = skills_for("personal", "student", has_session_files=False)
    with_files = skills_for("personal", "student", has_session_files=True)
    assert "read_session_file" not in without
    assert "read_session_file" in with_files
    assert "list_session_files" in with_files


def test_도구가_부족하면_계획_도구도_빼는다():
    """think는 순서를 정할 대상이 2개 이상일 때만 의미가 있다.

    실측(2026-07-28): 실도구 0개인 개인 세션에 think만 노출했더니 모델이 그걸
    불렀다. 계획을 세울 대상이 없는데 계획만 세우고 왕복 한 번을 버린 셈이다.
    """
    assert "think" in skills_for("class", "student", has_concepts=True)


def test_학급세션에는_학급_도구가_보인다():
    names = skills_for("class", "student", has_concepts=True)
    assert "search_class_material" in names
    assert "search_textbook_figure" in names


def test_교사는_학생_도구를_전부_포함해_더_본다():
    """교사 스킬은 추가일 뿐 — 학생이 쓰는 도구를 빼앗지 않는다."""
    student = set(skills_for("class", "student", has_concepts=True))
    teacher = set(skills_for("class", "teacher", has_concepts=True))
    assert student < teacher
    assert teacher - student == {"list_class_materials", "summarize_class_questions"}


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
        # D113: 실물과 같은 Completion(message, usage)을 돌려준다. 대역이 계약을
        # 다르게 인코딩하면 테스트가 통과해도 런타임이 깨진다(D112에서 실제로
        # 겪었다 — insert가 list를 돌려주는 대역 때문에 파일 인제스트가 죽어
        # 있었다).
        return O.solar.Completion(
            message={"role": "assistant", "content": "", "tool_calls": tc},
            usage={"prompt": 10, "completion": 5, "total": 15, "cached": 0},
        )

    async def fake_stream(history, question, system, *, usage_sink=None, **_):
        calls["stream"] += 1
        calls["system"] = system
        for ch in stream_text:
            yield ch
        if usage_sink is not None:
            usage_sink.update({"prompt": 100, "completion": 20, "total": 120, "cached": 0})

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
    assert outcome.used_skills == []  # 스킬이 하나도 안 돌았다
    assert "tool_call" not in " ".join(kinds)


async def test_도구를_부르면_실행하고_결과를_되돌린다(monkeypatch):
    tc = [
        {
            "id": "c1",
            "type": "function",
            "function": {"name": "echo", "arguments": '{"q":"광합성"}'},
        }
    ]
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
    assert calls["complete"] == 2  # 판단 → 결과 반영 후 재판단
    assert calls["stream"] == 1  # 생성은 마지막 1회
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
    tc = [{"id": "c", "type": "function", "function": {"name": "echo", "arguments": "{}"}}]
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

    async def fake_stream(history, question, system, *, usage_sink=None, **_):
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
                ok=True,
                message="ok",
                data={"sources": [{"name": "과학.pdf", "snippet": "엽록체에서 일어난다"}]},
            )

    tc = [{"id": "c", "type": "function", "function": {"name": "rag", "arguments": "{}"}}]
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
                ok=True,
                message="ok",
                data={
                    "figures": [
                        {"figure_id": "f1", "file_id": "x", "caption": "그림1"},
                        {"figure_id": "f1", "file_id": "x", "caption": "그림1"},
                    ]
                },
            )

    tc = [{"id": "c", "type": "function", "function": {"name": "fig", "arguments": "{}"}}]
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
    tc = [{"id": "c", "type": "function", "function": {"name": "echo", "arguments": "{망가진"}}]
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


async def test_모든_스킬_결과가_생성_프롬프트에_닿는다(monkeypatch):
    """전용 렌더가 없는 스킬의 결과도 생성 단계가 봐야 한다.

    실측 회귀(2026-07-28): rag_sources·figures만 렌더하던 시절,
    `summarize_class_questions`가 실제 질문 16건을 돌려줬는데도 생성 단계는
    아무것도 못 봤고 모델이 "시험 범위 질문이 많다"를 지어냈다.
    """

    class _Questions(SkillBase):
        name = "summarize"
        description = "d"
        parameters = {"type": "object", "properties": {}}

        async def run(self, args, ctx):
            return SkillResult(
                ok=True,
                message="최근 질문 2건.",
                data={"questions": ["광합성이 뭐야?", "지진은 왜 나?"]},
            )

    tc = [{"id": "c", "type": "function", "function": {"name": "summarize", "arguments": "{}"}}]
    calls = _patch_llm(monkeypatch, tool_calls_sequence=[tc, None])
    r = SkillRegistry()
    r.register(_Questions())
    await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="애들이 뭘 물어봐?",
        history=[],
        tool_names=["summarize"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert "광합성이 뭐야?" in calls["system"]
    assert "지어내지 마세요" in calls["system"]


async def test_실패한_스킬은_근거로_쓰이지_않는다(monkeypatch):
    """ok=False는 모델에게 tool_result로만 전달되고, 근거 블록엔 안 들어간다."""

    class _Fail(SkillBase):
        name = "boom"
        description = "d"
        parameters = {"type": "object", "properties": {}}

        async def run(self, args, ctx):
            return SkillResult(ok=False, message="권한 없음", error_code="forbidden")

    tc = [{"id": "c", "type": "function", "function": {"name": "boom", "arguments": "{}"}}]
    calls = _patch_llm(monkeypatch, tool_calls_sequence=[tc, None])
    r = SkillRegistry()
    r.register(_Fail())
    await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["boom"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert calls["system"] == "BASE"


async def test_큰_결과는_잘라서_넣는다(monkeypatch):
    """스킬이 큰 목록을 돌려줘도 프롬프트가 폭주하지 않는다."""

    class _Big(SkillBase):
        name = "big"
        description = "d"
        parameters = {"type": "object", "properties": {}}

        async def run(self, args, ctx):
            return SkillResult(ok=True, message="많음", data={"items": ["가" * 100] * 200})

    tc = [{"id": "c", "type": "function", "function": {"name": "big", "arguments": "{}"}}]
    calls = _patch_llm(monkeypatch, tool_calls_sequence=[tc, None])
    r = SkillRegistry()
    r.register(_Big())
    await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["big"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert "생략" in calls["system"]
    assert len(calls["system"]) < 6000


async def test_think_결과는_근거로_쓰이지_않는다(monkeypatch):
    """계획은 모델 자신의 산출물이지 조회한 사실이 아니다.

    근거 블록에 넣으면 "방금 도구로 확인한 실제 데이터"라는 문구와 함께 자기
    추측이 되돌아온다 — 모델이 자기 계획을 검증된 사실로 취급하게 된다.
    """

    class _Think(SkillBase):
        name = "think"
        description = "d"
        parameters = {"type": "object", "properties": {}}

        async def run(self, args, ctx):
            return SkillResult(
                ok=True,
                message="계획 완료",
                data={"reasoning": "자료를 먼저 찾고 그 다음에 설명한다"},
            )

    tc = [{"id": "c", "type": "function", "function": {"name": "think", "arguments": "{}"}}]
    calls = _patch_llm(monkeypatch, tool_calls_sequence=[tc, None])
    r = SkillRegistry()
    r.register(_Think())
    await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["think"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert calls["system"] == "BASE"
    assert "자료를 먼저 찾고" not in calls["system"]


async def test_같은_도구_중복_호출은_한_번만_돈다(monkeypatch):
    """모델이 같은 호출을 여러 번 요청해도 검색을 그만큼 반복하지 않는다.

    임베딩·Qdrant 왕복이 곱절로 드는 낭비다. 다만 tool_result는 호출 수만큼
    돌려줘야 한다 — 빠뜨리면 대화 형식이 깨져 다음 호출이 실패한다.
    """
    ran = []

    class _Count(SkillBase):
        name = "echo"
        description = "d"
        parameters = {"type": "object", "properties": {}}

        async def run(self, args, ctx):
            ran.append(args)
            return SkillResult(ok=True, message="ok", data={"v": 1})

    dup = [
        {"id": "c1", "type": "function", "function": {"name": "echo", "arguments": '{"q":"같음"}'}},
        {"id": "c2", "type": "function", "function": {"name": "echo", "arguments": '{"q":"같음"}'}},
        {"id": "c3", "type": "function", "function": {"name": "echo", "arguments": '{"q":"다름"}'}},
    ]
    _patch_llm(monkeypatch, tool_calls_sequence=[dup, None])
    r = SkillRegistry()
    r.register(_Count())
    kinds, _, outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["echo"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert len(ran) == 2  # 중복 하나는 생략
    assert outcome.used_skills == ["echo", "echo"]
    assert kinds.count("sse") == 4  # 실행된 2건의 call+result


async def test_실제_전송_프롬프트를_돌려준다(monkeypatch):
    """admin 로그가 실제와 어긋나지 않도록 최종 프롬프트를 outcome에 싣는다."""

    class _Rag(SkillBase):
        name = "rag"
        description = "d"
        parameters = {"type": "object", "properties": {}}

        async def run(self, args, ctx):
            return SkillResult(
                ok=True,
                message="ok",
                data={"sources": [{"name": "자료.pdf", "snippet": "엽록체"}]},
            )

    tc = [{"id": "c", "type": "function", "function": {"name": "rag", "arguments": "{}"}}]
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
    assert outcome.final_system == calls["system"]
    assert "엽록체" in outcome.final_system


def test_카탈로그와_레지스트리가_일치한다():
    """오타 하나로 스킬이 조용히 사라지는 것을 부팅 때 막는다."""
    from app import ai
    from app.ai.catalog import ALL_DECLARED

    assert set(ai.get_orchestrator().registry.names()) == set(ALL_DECLARED)


def test_학생_글이_있을_때만_글_스킬이_열린다():
    """파일 스킬과 **같은 규칙**이다 — 없는데 보여 주면 모델이 부르고 빈
    결과로 군더더기를 붙인다(2026-08-09)."""
    없음 = skills_for("personal", "student", has_concepts=True)
    있음 = skills_for("personal", "student", has_concepts=True, has_notes=True)
    assert "read_my_notes" not in 없음
    assert "read_my_notes" in 있음


def test_글만_있어도_카탈로그가_열린다():
    """글이 있으면 그 도구는 나온다 — 빈 세션 규칙은 "줄 것이 없을 때"의
    이야기이지, 글이 있는데 감추라는 뜻이 아니다."""
    names = skills_for("personal", "student", has_notes=True)
    assert "read_my_notes" in names
    # 계획 도구는 조합할 것이 둘 이상일 때만(D109) — 하나뿐이면 안 나온다.
    assert "think" not in names


def test_아무것도_없으면_여전히_도구가_없다():
    assert skills_for("personal", "student") == []
