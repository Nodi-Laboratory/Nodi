"""추천 의도 읽기 (D210 7-1) — "같이 설명해줘"와 "추천만 해줘"를 가른다.

D163은 개념 카드가 나온 턴이면 도판·클립을 자동으로 곁들인다. 그런데 학생의
말은 셋으로 갈린다:

    A "지진을 **이미지랑 같이** 설명해줘"  설명 + 곁들이 (반드시)
    B "이미지만 추천해줘"                  설명 없이 자료만
    C B인데 고른 카드가 없다               자료만, 화면 가운데에

B·C는 **개념 카드가 없는 턴**이라 D163의 규칙에 아예 안 걸린다. 그리고 설명을
안 쓰므로 생성 단계를 통째로 건너뛴다 — 이 갈래가 빠른 이유가 그것이다.
아래 테스트가 그 경계를 지킨다.
"""

from typing import Any

from app.ai.base import SkillBase, SkillContext, SkillResult
from app.ai.orchestrator import Orchestrator
from app.ai.registry import SkillRegistry
from app.ai.skills.media_intent import MediaIntentSkill


class _Clip(SkillBase):
    name = "search_lecture_clip"
    description = "강의 클립 검색"
    parameters = {"type": "object", "properties": {"query": {"type": "string"}}}
    calls: list[dict[str, Any]] = []
    hits = True

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        type(self).calls.append(args)
        if not type(self).hits:
            return SkillResult(ok=True, message="0개", data={"clips": []})
        return SkillResult(
            ok=True, message="1개",
            data={"clips": [{"clip_id": "c1", "title": "지진", "timeline_label": "01:00"}]},
        )


class _Figure(SkillBase):
    name = "search_textbook_figure"
    description = "교과서 도판 검색"
    parameters = {"type": "object", "properties": {"query": {"type": "string"}}}
    calls: list[dict[str, Any]] = []
    hits = True

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        type(self).calls.append(args)
        if not type(self).hits:
            return SkillResult(ok=True, message="0개", data={"figures": []})
        return SkillResult(
            ok=True, message="1개",
            data={"figures": [{"figure_id": "f1"}], "captions": ["캡션"]},
        )


def _ctx() -> SkillContext:
    return SkillContext(
        user_id="u1", client=object(), session_id="s1",
        space_kind="class", space_ref="c1", role="student",
    )


CARD = "@concept: 지진|지구의 변동\n판이 어긋나면서 생겨요."
STREAMED: list[bool] = []


def _patch(monkeypatch, tool_calls_sequence, answer: str = CARD):
    from app.ai import orchestrator as O

    seq = list(tool_calls_sequence)
    STREAMED.clear()

    async def fake_complete(messages, *, tools=None, max_tokens=None):
        tc = seq.pop(0) if seq else None
        return O.solar.Completion(
            message={"role": "assistant", "content": "", "tool_calls": tc},
            usage={"prompt": 10, "completion": 5, "total": 15, "cached": 0},
        )

    async def fake_stream(history, question, system, *, usage_sink=None, **_):
        STREAMED.append(True)
        yield answer

    monkeypatch.setattr(O.solar, "complete", fake_complete)
    monkeypatch.setattr(O.solar, "stream_answer", fake_stream)


def _call(name: str, args: str) -> dict[str, Any]:
    return {"id": name, "type": "function", "function": {"name": name, "arguments": args}}


def _registry() -> SkillRegistry:
    r = SkillRegistry()
    for s in (_Clip(), _Figure(), MediaIntentSkill()):
        r.register(s)
    return r


ALL = ["search_textbook_figure", "search_lecture_clip", "set_media_intent"]


async def _drain(orch, **kw):
    outcome, tokens = None, []
    async for kind, payload in orch.run(**kw):
        if kind == "outcome":
            outcome = payload
        elif kind == "token":
            tokens.append(payload)
    return outcome, "".join(tokens)


def _reset():
    _Clip.calls, _Figure.calls = [], []
    _Clip.hits = _Figure.hits = True


async def test_A_같이_설명해줘는_설명도_쓰고_반드시_곁들인다(monkeypatch):
    _reset()
    _patch(monkeypatch, [[_call("set_media_intent", '{"mode":"with_answer"}')], None])
    outcome, text = await _drain(
        Orchestrator(_registry()), ctx=_ctx(),
        question="지진을 이미지랑 같이 설명해줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.media_mode == "with_answer"
    assert STREAMED == [True], "설명은 그대로 생성돼야 한다"
    assert text == CARD
    assert [f["figure_id"] for f in outcome.figures] == ["f1"]
    assert [c["clip_id"] for c in outcome.clips] == ["c1"]


async def test_A는_카드가_없어도_곁들인다(monkeypatch):
    """학생이 콕 집어 요청했다 — 개념 카드 유무로 가르면 안 된다.

    D163의 신호(개념 카드)는 "이 턴이 배우는 턴인가"를 재는 것이지 "학생이
    요청했는가"가 아니다. 요청했는데 안 뜨면 학생 눈에는 고장이다.
    """
    _reset()
    _patch(
        monkeypatch,
        [[_call("set_media_intent", '{"mode":"with_answer"}')], None],
        answer="CHAT: 네, 찾아볼게요.",
    )
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx(),
        question="지진 이미지도 같이 보여줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert [f["figure_id"] for f in outcome.figures] == ["f1"]


async def test_B_추천만_해줘는_생성_단계를_건너뛴다(monkeypatch):
    """이 갈래가 빠른 이유가 생성을 안 하는 것이다."""
    _reset()
    _patch(monkeypatch, [[_call("set_media_intent", '{"mode":"only"}')], None])
    outcome, text = await _drain(
        Orchestrator(_registry()), ctx=_ctx(),
        question="지진 이미지만 추천해줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.media_mode == "only"
    assert STREAMED == [], "생성 단계가 돌면 안 된다"
    # 개념 카드 형식이 없어야 카드가 안 만들어진다.
    assert text.startswith("CHAT: ")
    assert "@concept" not in text
    assert [f["figure_id"] for f in outcome.figures] == ["f1"]


async def test_B_종류를_콕_집으면_그것만_찾는다(monkeypatch):
    """'영상 추천해줘'에 도판이 딸려 오면 묻지 않은 것을 준 셈이다."""
    _reset()
    _patch(monkeypatch, [[_call("set_media_intent", '{"mode":"only","kinds":["clip"]}')], None])
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx(),
        question="지진 영상만 추천해줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.clips and not outcome.figures
    assert _Figure.calls == []


async def test_B_빈손이면_찾은_것이_없다고_말한다(monkeypatch):
    """조용히 아무것도 안 뜨면 요청이 씹힌 것과 구분할 수 없다."""
    _reset()
    _Clip.hits = _Figure.hits = False
    _patch(monkeypatch, [[_call("set_media_intent", '{"mode":"only"}')], None])
    outcome, text = await _drain(
        Orchestrator(_registry()), ctx=_ctx(),
        question="지진 이미지만 추천해줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert not outcome.figures and not outcome.clips
    assert text.startswith("CHAT: ")
    assert "없" in text, f"빈손을 알리지 않았다: {text}"


async def test_의도를_안_부르면_지금까지와_같다(monkeypatch):
    """평범한 질문 — 이 기능이 기존 동작을 건드리면 안 된다."""
    _reset()
    _patch(monkeypatch, [None])
    outcome, text = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="지진이 왜 생겨?",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.media_mode == ""
    assert STREAMED == [True]
    assert text == CARD
    # 카드가 나왔으니 D163의 곁들이 보장은 그대로 돈다.
    assert outcome.figures and outcome.clips


async def test_모르는_mode는_안_부른_것으로_친다(monkeypatch):
    """오타 하나로 설명이 통째로 사라지면 안 된다."""
    _reset()
    _patch(monkeypatch, [[_call("set_media_intent", '{"mode":"only_images"}')], None])
    outcome, text = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="지진 이미지만 추천해줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.media_mode == ""
    assert STREAMED == [True], "판정이 실패하면 설명은 그대로 나와야 한다"


async def test_의도는_근거로_안_실린다(monkeypatch):
    """모델의 선언은 조회한 사실이 아니다 — 근거 블록에 들어가면 설명에 섞인다."""
    _reset()
    _patch(monkeypatch, [[_call("set_media_intent", '{"mode":"with_answer"}')], None])
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="지진 이미지랑 같이 설명해줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert "set_media_intent" not in outcome.final_system


async def test_그림_영상_얘기가_없으면_only는_되돌린다(monkeypatch):
    """`only`는 설명을 통째로 없애는 판정이라 헛발이 제일 비싸다.

    실측 2026-08-08: 모델이 "고마워!"에 only를 선언했다. 그대로 두면 인사
    턴에 검색이 나가고(CLAUDE.md: 인사에는 임베딩이 아예 나가면 안 된다)
    답이 "찾은 것이 없어요"가 된다.

    낱말은 **고르는 데 안 쓰고 되돌리는 데만 쓴다** — 판정은 여전히 모델이
    하고, 여기서는 학생이 입에 담지도 않은 것을 막을 뿐이다.
    """
    _reset()
    _patch(monkeypatch, [[_call("set_media_intent", '{"mode":"only"}')], None])
    outcome, text = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="고마워!",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.media_mode == ""
    assert STREAMED == [True], "설명 경로로 돌아와야 한다"
    assert text == CARD


async def test_with_answer에는_거부권이_없다(monkeypatch):
    """헛발이어도 곁들이가 하나 더 뜰 뿐이다 — 막을 이유가 없다."""
    _reset()
    _patch(monkeypatch, [[_call("set_media_intent", '{"mode":"with_answer"}')], None])
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="고마워!",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.media_mode == "with_answer"


async def test_주제어로_찾는다_문장_그대로_쓰면_빈손이다(monkeypatch):
    """`topic`은 있으면 좋은 값이 아니라 **이 기능이 되게 하는 값**이다.

    실측 2026-08-08(실물 임베딩): "지진파 영상만 추천해줘"로는 3/3 빈손이고
    "지진파"로는 걸렸다. 요청 표현이 임베딩을 끌고 가 거리 게이트(0.60)를
    넘긴다 — 요청한 학생이 빈손을 받는 것이 이 갈래에서 가장 나쁜 결과다.
    """
    _reset()
    _patch(
        monkeypatch,
        [[_call("set_media_intent", '{"mode":"only","kinds":["clip"],"topic":"지진파"}')], None],
    )
    outcome, _ = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="지진파 영상만 추천해줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert outcome.media_topic == "지진파"
    assert _Clip.calls[0] == {"query": "지진파"}, _Clip.calls


async def test_주제어가_빈손이면_원문으로_한_번_더(monkeypatch):
    """다듬은 검색어가 빈손이어도 원문으로는 걸리는 일이 있다(D135·D163)."""
    _reset()
    _Clip.hits = False
    _patch(
        monkeypatch,
        [[_call("set_media_intent", '{"mode":"only","kinds":["clip"],"topic":"지진파"}')], None],
    )
    await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="지진파 영상만 추천해줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert [c["query"] for c in _Clip.calls] == ["지진파", "지진파 영상만 추천해줘"]


async def test_건졌으면_두_번_찾지_않는다(monkeypatch):
    _reset()
    _patch(
        monkeypatch,
        [[_call("set_media_intent", '{"mode":"only","kinds":["clip"],"topic":"지진파"}')], None],
    )
    await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="지진파 영상만 추천해줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert len(_Clip.calls) == 1


async def test_찾을_곳이_없으면_그렇게_말한다(monkeypatch):
    """개인 대화방에는 선생님이 올린 교과서·강의가 없다 (D211 11).

    학급에만 의도 판정을 열어 뒀더니 개인 세션에서 "이미지만 추천해줘"가
    평소 답으로 흘렀다 — 학생이 쓰는 곳은 대개 개인 세션이라 **기능이 있는데
    없는 것처럼** 보였다.

    "못 찾았어요"와 "여기서는 못 찾아요"는 다른 말이다: 앞은 다시 물어보게
    하고 뒤는 자리를 옮기게 한다.
    """
    _reset()
    _patch(monkeypatch, [[_call("set_media_intent", '{"mode":"only","topic":"지진파"}')], None])
    # 검색 도구가 하나도 없는 카탈로그(개인 세션).
    outcome, text = await _drain(
        Orchestrator(_registry()), ctx=_ctx(),
        question="지진파 이미지만 추천해줘",
        history=[], tool_names=["set_media_intent"],
        answer_system_prompt="BASE", max_steps=3,
    )
    # **설명을 지우지 않는다** — 찾을 곳이 없는 곳에서 생성을 건너뛰면 학생에게
    # 남는 것이 안내 한 줄뿐이다.
    assert outcome.media_mode == ""
    assert STREAMED == [True], "평소대로 설명해야 한다"
    assert text.startswith(CARD), "답이 먼저 오고"
    assert "학급" in text, f"어디로 가야 하는지 안 알려 준다: {text}"


async def test_찾을_곳이_있으면_빈손_문구는_그대로(monkeypatch):
    """둘을 헷갈리면 학급에서 못 찾은 학생이 엉뚱하게 자리를 옮긴다."""
    _reset()
    _Clip.hits = _Figure.hits = False
    _patch(monkeypatch, [[_call("set_media_intent", '{"mode":"only"}')], None])
    _outcome, text = await _drain(
        Orchestrator(_registry()), ctx=_ctx(),
        question="지진파 이미지만 추천해줘",
        history=[], tool_names=ALL, answer_system_prompt="BASE", max_steps=3,
    )
    assert "학급" not in text
    assert "없었" in text



async def test_찾을_곳이_없으면_모델_판정을_안_기다린다(monkeypatch):
    """결과가 같은 갈래를 위해 모델 순응을 쫓지 않는다 (D211 11).

    실측 2026-08-08: 찾을 도구가 없는 카탈로그에서 모델은 `set_media_intent`를
    **한 번도 안 불렀다**(도구 0건). 그런데 여기서는 판정이 결과를 안 바꾼다 —
    자료만 달라고 했든 함께 달라고 했든 할 수 있는 일은 하나뿐이다.
    """
    _reset()
    _patch(monkeypatch, [None])  # 모델이 아무 도구도 안 부른다
    outcome, text = await _drain(
        Orchestrator(_registry()), ctx=_ctx(),
        question="지진파 이미지만 추천해줘",
        history=[], tool_names=["set_media_intent"],
        answer_system_prompt="BASE", max_steps=3,
    )
    assert "학급" in text, f"안내가 없다: {text}"
    assert outcome.media_note


async def test_그림_얘기가_없으면_안내도_없다(monkeypatch):
    """평범한 질문에 "학급으로 가세요"가 붙으면 군더더기다."""
    _reset()
    _patch(monkeypatch, [None])
    _outcome, text = await _drain(
        Orchestrator(_registry()), ctx=_ctx(), question="지진파가 뭐야?",
        history=[], tool_names=["set_media_intent"],
        answer_system_prompt="BASE", max_steps=3,
    )
    assert "학급" not in text
