"""D113 — 턴 관측성: 실측 토큰 · 스킬 트레이스.

고정하는 계약 셋:
  1. **어림을 실측인 척하지 않는다** — LLM usage가 하나도 없으면 tokens는 빈
     dict다. 글자수/4 어림은 token_estimate 칸에만 남는다.
  2. **스킬 트레이스에 인자와 결과가 남는다** — 이름만으로는 "왜 그 답이
     나왔나"를 되짚을 수 없다.
  3. **큰 결과는 자르되 자른 사실을 남긴다** — 조용히 자르면 관리자가 스킬이
     그만큼만 돌려준 줄 오해한다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.ai.base import SkillBase, SkillContext, SkillResult
from app.ai.orchestrator import Orchestrator, _trace_data
from app.ai.registry import SkillRegistry
from app.services import solar
from app.services.turn_log import TurnLog

pytestmark = pytest.mark.asyncio


# ── usage 파싱 ────────────────────────────────────────────────────────
def test_usage_of는_캐시_토큰까지_읽는다():
    """프리픽스 캐시가 먹고 있는지는 cached_tokens 말고 볼 방법이 없다."""
    raw = {
        "prompt_tokens": 22,
        "completion_tokens": 38,
        "total_tokens": 60,
        "prompt_tokens_details": {"cached_tokens": 16},
    }
    assert solar.usage_of(raw) == {
        "prompt": 22,
        "completion": 38,
        "total": 60,
        "cached": 16,
    }


def test_usage_of는_빈_응답에도_0을_돌려준다():
    assert solar.usage_of(None) == {
        "prompt": 0,
        "completion": 0,
        "total": 0,
        "cached": 0,
    }


# ── TurnLog 토큰 합산 ─────────────────────────────────────────────────
def test_실측이_없으면_tokens는_비어_있다():
    """어림값(token_estimate)을 tokens 칸에 밀어 넣지 않는다 — 콘솔이 추정을
    실측으로 표시하게 되기 때문이다."""
    log = TurnLog("u1", "s1", "광합성이 무엇인지 자세히 알려주세요")
    assert log.tokens() == {}
    row = log.to_row()
    assert row["tokens"] == {}
    assert row["token_estimate"] > 0  # 어림은 따로 남아 있다


def test_여러_LLM_호출이_합산된다():
    log = TurnLog("u1", "s1", "질문")
    log.add_llm_calls(
        [
            {"stage": "decide", "prompt": 100, "completion": 20, "total": 120, "cached": 0},
            {"stage": "answer", "prompt": 500, "completion": 300, "total": 800, "cached": 80},
        ]
    )
    tokens = log.tokens()
    assert tokens["prompt"] == 600
    assert tokens["completion"] == 320
    assert tokens["total"] == 920
    assert tokens["cached"] == 80
    # 합계만 남기면 어느 단계가 비싼지 알 수 없다 — 내역도 함께.
    assert [c["stage"] for c in tokens["calls"]] == ["decide", "answer"]


def test_route와_모델이_행에_남는다():
    """react_enabled를 나중에 끄면 과거 로그의 해석이 달라진다."""
    log = TurnLog("u1", "s1", "질문")
    log.set_route("react", "solar-pro2")
    row = log.to_row()
    assert row["route"] == "react"
    assert row["model"] == "solar-pro2"
    assert row["duration_ms"] >= 0


# ── 트레이스 절단 ─────────────────────────────────────────────────────
def test_작은_결과는_그대로_남는다():
    data = {"sources": [{"name": "a.pdf"}]}
    assert _trace_data(data) is data


def test_큰_결과는_잘리되_잘린_사실을_남긴다():
    """read_session_file은 파일 전문을 돌려준다 — 상한이 없으면 로그 한 행이
    수만 자가 된다."""
    data = {"text": "가" * 10_000}
    out = _trace_data(data)
    assert out["_truncated"] is True
    assert out["_chars"] > 10_000
    assert out["_keys"] == ["text"]
    assert len(out["_preview"]) == 4000


# ── 오케스트레이터 트레이스 ──────────────────────────────────────────
class _Echo(SkillBase):
    name = "echo"
    description = "받은 것을 그대로 돌려준다"
    parameters = {"type": "object", "properties": {"q": {"type": "string"}}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        return SkillResult(ok=True, message="ok", data={"echo": args.get("q", "")})


def _ctx() -> SkillContext:
    return SkillContext(
        user_id="u1",
        client=object(),
        session_id="s1",
        space_kind="class",
        space_ref="c1",
        role="student",
    )


def _patch(monkeypatch, tool_calls_sequence):
    from app.ai import orchestrator as O

    seq = list(tool_calls_sequence)

    async def fake_complete(messages, *, tools=None, max_tokens=None):
        tc = seq.pop(0) if seq else None
        return O.solar.Completion(
            message={"role": "assistant", "content": "", "tool_calls": tc},
            usage={"prompt": 10, "completion": 5, "total": 15, "cached": 0},
        )

    async def fake_stream(history, question, system, *, usage_sink=None, **_):
        yield "답"
        if usage_sink is not None:
            usage_sink.update(
                {"prompt": 200, "completion": 50, "total": 250, "cached": 30}
            )

    monkeypatch.setattr(O.solar, "complete", fake_complete)
    monkeypatch.setattr(O.solar, "stream_answer", fake_stream)


async def _drain(orch, **kw):
    outcome = None
    async for kind, payload in orch.run(**kw):
        if kind == "outcome":
            outcome = payload
    return outcome


async def test_스킬_트레이스에_인자와_결과가_남는다(monkeypatch):
    tc = [
        {
            "id": "c1",
            "type": "function",
            "function": {"name": "echo", "arguments": '{"q":"광합성"}'},
        }
    ]
    _patch(monkeypatch, [tc, None])
    r = SkillRegistry()
    r.register(_Echo())
    outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="광합성",
        history=[],
        tool_names=["echo"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert len(outcome.skill_traces) == 1
    trace = outcome.skill_traces[0]
    assert trace["skill"] == "echo"
    assert trace["args"] == {"q": "광합성"}   # 입력이 뭐였나
    assert trace["ok"] is True
    assert trace["data"] == {"echo": "광합성"}  # 결과가 뭐였나
    assert trace["duration_ms"] >= 0


async def test_판단과_생성의_토큰이_따로_기록된다(monkeypatch):
    """어느 단계가 비싼지 나뉘어 보여야 상한을 어디서 조일지 판단할 수 있다."""
    tc = [
        {
            "id": "c1",
            "type": "function",
            "function": {"name": "echo", "arguments": "{}"},
        }
    ]
    _patch(monkeypatch, [tc, None])
    r = SkillRegistry()
    r.register(_Echo())
    outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["echo"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    stages = [c["stage"] for c in outcome.llm_calls]
    assert stages == ["decide", "decide", "answer"]
    assert outcome.llm_calls[-1]["cached"] == 30


async def test_중복_호출_생략도_트레이스에_남는다(monkeypatch):
    """모델이 같은 호출을 반복하는 버릇은 콘솔에서 보여야 고칠 수 있다."""
    same = {
        "id": "c1",
        "type": "function",
        "function": {"name": "echo", "arguments": '{"q":"x"}'},
    }
    _patch(monkeypatch, [[same, {**same, "id": "c2"}], None])
    r = SkillRegistry()
    r.register(_Echo())
    outcome = await _drain(
        Orchestrator(r),
        ctx=_ctx(),
        question="q",
        history=[],
        tool_names=["echo"],
        answer_system_prompt="BASE",
        max_steps=3,
    )
    assert [t.get("skipped", False) for t in outcome.skill_traces] == [False, True]
    # 실행은 한 번뿐이다.
    assert outcome.used_skills == ["echo"]
