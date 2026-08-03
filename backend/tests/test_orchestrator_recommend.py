"""곁들이 보장 (D163) — 모델이 안 불러도 추천 스킬은 돈다.

## 왜 필요한가

ReAct는 도구를 모델이 고른다(D109). 실측(2026-08-03, 통합과학 학급):

    "실험실에서 안전하게 실험하려면?"  → search_class_material만 호출
    "정확도랑 정밀도 차이가 뭐야?"     → 도구 0건 (안다고 생각해서)

둘 다 학급에 켜 둔 EBS 강의 클립이 거리 0.49로 걸리는 질문이었다. 선생님이
올려 둔 강의도, 인덱싱해 둔 교과서 도판도 학생 화면에 **영영 안 뜬다.**
D135가 같은 결론에 이미 도달했다: "선택 스킬에 맡기면 모델이 안 불러서 보장이
깨진다."

## 언제 도는가 — 개념 카드가 나온 턴에만

인사·잡담 턴에는 임베딩·검색이 **아예 나가지 않아야 한다**(CLAUDE.md). 판단
단계의 도구 호출 여부로는 그 둘이 안 갈린다(위 두 번째 실측이 도구 0건이다).
그래서 **생성 결과**를 신호로 쓴다 — 개념 카드가 만들어졌으면 배운 턴이고,
인사면 카드가 없다. 아래 테스트들이 그 경계다.
"""

from typing import Any

from app.ai.base import SkillBase, SkillContext, SkillResult
from app.ai.orchestrator import Orchestrator
from app.ai.registry import SkillRegistry


class _Material(SkillBase):
    name = "search_class_material"
    description = "수업 자료 검색"
    parameters = {"type": "object", "properties": {"query": {"type": "string"}}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        return SkillResult(ok=True, message="2곳", data={"sources": [{"title": "t"}]})


class _Clip(SkillBase):
    name = "search_lecture_clip"
    description = "강의 클립 검색"
    parameters = {"type": "object", "properties": {"query": {"type": "string"}}}

    calls: list[dict[str, Any]] = []

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        type(self).calls.append(args)
        return SkillResult(
            ok=True,
            message="1개",
            data={"clips": [{"clip_id": "c1", "title": "실험실 안전 수칙",
                             "timeline_label": "06:42"}]},
        )


class _Figure(SkillBase):
    name = "search_textbook_figure"
    description = "교과서 도판 검색"
    parameters = {"type": "object", "properties": {"query": {"type": "string"}}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        return SkillResult(ok=True, message="1개",
                           data={"figures": [{"figure_id": "f1"}], "captions": ["캡션"]})


class _Think(SkillBase):
    name = "think"
    description = "생각한다"
    parameters = {"type": "object", "properties": {"plan": {"type": "string"}}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        return SkillResult(ok=True, message="계획", data={"plan": "..."})


def _ctx(space_kind: str = "class") -> SkillContext:
    return SkillContext(
        user_id="u1", client=object(), session_id="s1",
        space_kind=space_kind, space_ref="c1", role="student",
    )


# 개념 카드가 있는 답 / 없는 답. 보장이 도는 기준이 바로 이 차이다.
CARD = "@concept: 실험실 안전 수칙|과학 실험 안전\n실험복과 보안경을 착용해요."
CHAT = "CHAT: 천만에요! 또 궁금한 게 있으면 물어보세요."


def _patch(monkeypatch, tool_calls_sequence, answer: str = CARD):
    from app.ai import orchestrator as O

    seq = list(tool_calls_sequence)

    async def fake_complete(messages, *, tools=None, max_tokens=None):
        tc = seq.pop(0) if seq else None
        return O.solar.Completion(
            message={"role": "assistant", "content": "", "tool_calls": tc},
            usage={"prompt": 10, "completion": 5, "total": 15, "cached": 0},
        )

    async def fake_stream(history, question, system, *, usage_sink=None):
        yield answer

    monkeypatch.setattr(O.solar, "complete", fake_complete)
    monkeypatch.setattr(O.solar, "stream_answer", fake_stream)


def _call(name: str, args: str = '{"query":"실험실 안전"}') -> list[dict[str, Any]]:
    return [{"id": "x", "type": "function",
             "function": {"name": name, "arguments": args}}]


def _registry() -> SkillRegistry:
    r = SkillRegistry()
    for s in (_Material(), _Clip(), _Figure(), _Think()):
        r.register(s)
    return r


ALL = ["search_class_material", "search_textbook_figure", "search_lecture_clip", "think"]


async def _drain(orch, **kw):
    outcome = None
    events = []
    async for kind, payload in orch.run(**kw):
        if kind == "outcome":
            outcome = payload
        elif kind == "sse":
            events.append(payload)
    return outcome, events


async def test_자료검색만_부른_턴에도_강의클립과_도판이_돈다(monkeypatch):
    _Clip.calls = []
    _patch(monkeypatch, [_call("search_class_material"), None])
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="실험실 안전 수칙이 뭐야?",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.used_skills == [
        "search_class_material", "search_textbook_figure", "search_lecture_clip",
    ]
    # 화면에 띄울 것이 실제로 모였나 — 이게 안 되면 카드가 안 뜬다.
    assert [c["clip_id"] for c in outcome.clips] == ["c1"]
    assert [f["figure_id"] for f in outcome.figures] == ["f1"]
    # 검색어는 학생의 질문 원문이다(모델이 안 골랐으므로).
    assert _Clip.calls == [{"query": "실험실 안전 수칙이 뭐야?"}]


async def test_도구를_하나도_안_불러도_카드가_나왔으면_돈다(monkeypatch):
    """가장 중요한 경우다.

    모델이 "이건 내가 안다"며 도구를 아예 안 부른 턴에도 개념 카드는 나온다.
    예전 조건(도구를 불렀는가)으로는 여기서 추천이 0건이었다 — 실측으로 잡은
    바로 그 구멍이다.
    """
    _Clip.calls = []
    _patch(monkeypatch, [None])
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="정확도랑 정밀도 차이가 뭐야?",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert [c["clip_id"] for c in outcome.clips] == ["c1"]
    assert _Clip.calls == [{"query": "정확도랑 정밀도 차이가 뭐야?"}]


async def test_인사_턴에는_아무것도_안_나간다(monkeypatch):
    """개념 카드가 없는 답 = 인사·잡담. 임베딩이 나가면 안 된다(CLAUDE.md)."""
    _Clip.calls = []
    _patch(monkeypatch, [None], answer=CHAT)
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="고마워!",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.used_skills == []
    assert outcome.clips == []
    assert _Clip.calls == []


async def test_모델이_불러서_건졌으면_두_번_부르지_않는다(monkeypatch):
    _Clip.calls = []
    _patch(monkeypatch, [_call("search_lecture_clip", '{"query":"광합성 영상"}'), None])
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="광합성 알려줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.used_skills.count("search_lecture_clip") == 1
    # 모델이 고른 검색어가 살아 있다 — 우리 원문으로 덮어쓰지 않는다.
    assert _Clip.calls == [{"query": "광합성 영상"}]


async def test_모델이_다듬은_검색어로_빈손이면_원문으로_다시_찾는다(monkeypatch):
    """실측(2026-08-03): 모델이 "측정 표준이 왜 필요해?"를 "측정 표준의 필요성"
    으로 다듬어 부르는 바람에 0건이었는데, 원문 임베딩으로는 거리 0.588로
    걸렸다. 모델이 불렀다는 사실만으로 넘기면 이런 턴이 조용히 비어 버린다.
    """
    class _Empty(_Clip):
        async def run(self, args, ctx):
            _Clip.calls.append(args)
            # 다듬은 검색어에는 빈손, 원문에는 결과.
            if args.get("query") == "측정 표준의 필요성":
                return SkillResult(ok=True, message="못 찾음", data={"clips": []})
            return SkillResult(ok=True, message="1개",
                               data={"clips": [{"clip_id": "c9", "title": "측정 표준"}]})

    _Clip.calls = []
    r = SkillRegistry()
    for s in (_Material(), _Empty(), _Figure(), _Think()):
        r.register(s)
    _patch(monkeypatch, [_call("search_lecture_clip", '{"query":"측정 표준의 필요성"}'), None])
    outcome, _ = await _drain(
        Orchestrator(r), ctx=_ctx(), question="측정 표준이 왜 필요해?",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert _Clip.calls == [
        {"query": "측정 표준의 필요성"},      # 모델이 고른 것
        {"query": "측정 표준이 왜 필요해?"},   # 빈손이라 원문으로 한 번 더
    ]
    assert [c["clip_id"] for c in outcome.clips] == ["c9"]


async def test_같은_검색어로_빈손이면_다시_부르지_않는다(monkeypatch):
    """원문 그대로 불러서 없었던 것은 다시 불러도 없다 — 임베딩 한 번 낭비다."""
    class _Empty(_Clip):
        async def run(self, args, ctx):
            _Clip.calls.append(args)
            return SkillResult(ok=True, message="못 찾음", data={"clips": []})

    _Clip.calls = []
    r = SkillRegistry()
    for s in (_Material(), _Empty(), _Figure(), _Think()):
        r.register(s)
    _patch(monkeypatch, [_call("search_lecture_clip", '{"query":"광합성 알려줘"}'), None])
    await _drain(
        Orchestrator(r), ctx=_ctx(), question="광합성 알려줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert _Clip.calls == [{"query": "광합성 알려줘"}]


async def test_카탈로그에_없으면_부르지_않는다(monkeypatch):
    """개인 세션에는 학급 도구가 아예 안 보인다(catalog.py). 보장도 그 선을 넘지 않는다."""
    _Clip.calls = []
    _patch(monkeypatch, [_call("search_class_material"), None])
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx("personal"), question="실험실 안전",
        history=[], tool_names=["search_class_material", "think"],
        answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.used_skills == ["search_class_material"]
    assert _Clip.calls == []


async def test_보장_호출도_SSE로_보인다(monkeypatch):
    """화면의 '찾아보고 있어요' 표시가 이 이벤트를 쓴다. 조용히 돌면 안 된다."""
    _Clip.calls = []
    _patch(monkeypatch, [_call("search_class_material"), None])
    _, events = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="실험실 안전",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    joined = "".join(events)
    assert joined.count("search_lecture_clip") >= 2      # tool_call + tool_result
    assert "tool_result" in joined


async def test_보장_호출은_트레이스에_auto로_남는다(monkeypatch):
    """운영 콘솔에서 '모델이 골랐나, 시스템이 걸었나'가 갈려야 한다."""
    _patch(monkeypatch, [_call("search_class_material"), None])
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="실험실 안전",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    auto = [t for t in outcome.skill_traces if t.get("auto")]
    assert {t["skill"] for t in auto} == {"search_lecture_clip", "search_textbook_figure"}
    assert all(t["step"] == -1 for t in auto)
