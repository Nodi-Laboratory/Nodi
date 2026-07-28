"""ReAct 루프 — 도구 판단 → 스킬 실행 → 최종 생성 (D109).

## 왜 2단계인가

한 번의 호출로 "도구도 고르고 개념 카드도 쓰게" 하면 두 지시가 충돌한다.
형식을 지키느라 도구를 안 부르거나, 도구를 부르느라 형식을 깬다. 그래서
**시점으로 역할을 나눈다**:

  판단 단계  시스템 프롬프트에 개념 카드 형식이 **없다**. 도구 설명만 있다.
             비스트리밍 호출이고, 이 단계의 텍스트는 **버린다**(사용자에게 안 감).
  생성 단계  기존 개념 카드 프롬프트 그대로. `tools`를 **주지 않는다** —
             도구를 못 부르니 형식에만 집중한다. 여기만 진짜 스트리밍이다.

판단 단계의 텍스트를 버리는 건 안전장치이기도 하다. 모델이 추론 과정을 content에
흘리는 일이 실제로 있는데(2026-07-28 EXAONE 실측), 그게 사용자 화면으로 새지
않는다.

## 도구를 안 쓰면

판단 단계가 `tool_calls` 없이 끝나면 곧장 생성 단계로 간다. 인사 한 마디에
질의 임베딩·Qdrant 검색이 나가던 낭비가 여기서 사라진다.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from ..services import solar
from .base import SkillContext
from .registry import SkillRegistry

logger = logging.getLogger("nodi.ai.orchestrator")

# 판단 단계 시스템 프롬프트. 개념 카드 형식을 **일부러 넣지 않는다**(위 설명).
_DECIDE_SYSTEM = """너는 중·고등학생을 가르치는 교사 보조 시스템의 도구 선택기다.
학생의 질문을 읽고, 더 나은 답을 위해 **자료를 찾아봐야 하는지** 판단한다.

- 수업 자료·교과서에 근거해야 하는 질문이면 해당 도구를 부른다.
- 인사·잡담·감사 인사, 또는 일반 상식으로 충분한 질문이면 **아무 도구도 부르지 마라.**
- 도구를 부를 때는 학생의 표현을 그대로 검색어로 써도 된다.
- 도구를 부르지 않기로 했다면 아주 짧게 한 마디만 하고 끝낸다(이 텍스트는 학생에게 보이지 않는다).
"""


@dataclass
class TurnOutcome:
    """루프가 끝난 뒤 라우터가 쓰는 부산물."""

    # 자료 검색 스킬이 만든 출처 — 답변 노드에 실어 출처 칩으로 쓴다(D32/D74).
    rag_sources: list[dict[str, Any]] = field(default_factory=list)
    # 도판 검색 스킬이 만든 항목 — 캔버스 리프로 띄우고 attachments에 영속한다.
    figures: list[dict[str, Any]] = field(default_factory=list)
    # 실행된 스킬 이름(로그·관측성).
    used_skills: list[str] = field(default_factory=list)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _tool_result_text(result: Any) -> str:
    """tool_result 메시지에 실을 문자열. 실패도 그대로 알려 준다.

    실패를 숨기면 모델이 같은 도구를 계속 부른다. 무엇이 왜 안 됐는지 주면
    다른 도구를 고르거나 아는 선에서 답한다.
    """
    payload = {"ok": result.ok, "message": result.message}
    if result.data:
        payload.update(result.data)
    return json.dumps(payload, ensure_ascii=False, default=str)


class Orchestrator:
    def __init__(self, registry: SkillRegistry) -> None:
        self.registry = registry

    async def run(
        self,
        *,
        ctx: SkillContext,
        question: str,
        history: list[tuple[str, str]],
        tool_names: list[str],
        answer_system_prompt: str,
        max_steps: int,
    ) -> AsyncIterator[tuple[str, Any]]:
        """`(kind, payload)`를 yield.

        kind는 셋뿐이다:
          "sse"     — 그대로 클라이언트에 흘릴 SSE 문자열
          "token"   — 최종 답변 델타(라우터가 SSE token으로 감싸고 원문도 모은다)
          "outcome" — 마지막에 한 번, TurnOutcome

        라우터가 SSE 포맷을 이미 소유하고 있어서 완성된 문자열을 그대로 넘기지
        않고 종류를 붙여 준다 — 토큰만은 라우터가 답변 원문으로도 쌓아야 한다.
        """
        outcome = TurnOutcome()
        catalog = self.registry.catalog(tool_names)

        # 판단 단계 대화 — 히스토리는 짧게(최근 몇 턴)만 준다. 도구 판단에
        # 긴 맥락이 필요하지 않고, 입력이 커지면 그만큼 느려진다.
        messages: list[dict[str, Any]] = [{"role": "system", "content": _DECIDE_SYSTEM}]
        for q, a in history[-3:]:
            if q:
                messages.append({"role": "user", "content": q})
            if a:
                messages.append({"role": "assistant", "content": a[:500]})
        messages.append({"role": "user", "content": question})

        if catalog:
            for _step in range(max_steps):
                try:
                    msg = await solar.complete(messages, tools=catalog, max_tokens=512)
                except Exception:  # noqa: BLE001 - 판단 실패가 턴을 죽이지 않는다
                    logger.exception("도구 판단 호출 실패 — 도구 없이 진행한다")
                    break

                tool_calls = msg.get("tool_calls") or []
                if not tool_calls:
                    break  # 도구 불필요 — 바로 생성 단계로

                # assistant의 tool_calls를 그대로 히스토리에 넣어야 다음 호출에서
                # 모델이 자기가 무엇을 불렀는지 안다.
                messages.append(
                    {
                        "role": "assistant",
                        "content": msg.get("content") or "",
                        "tool_calls": tool_calls,
                    }
                )

                for call in tool_calls:
                    fn = call.get("function") or {}
                    name = fn.get("name") or ""
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    if not isinstance(args, dict):
                        args = {}

                    yield ("sse", _sse("tool_call", {"name": name, "args": args}))

                    result = await self.registry.dispatch(name, args, ctx)
                    outcome.used_skills.append(name)
                    self._collect(outcome, result)

                    yield (
                        "sse",
                        _sse(
                            "tool_result",
                            {"name": name, "ok": result.ok, "message": result.message},
                        ),
                    )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.get("id") or name,
                            "content": _tool_result_text(result),
                        }
                    )
            else:
                logger.info("ReAct 스텝 상한(%d) 도달 — 생성 단계로 넘어간다", max_steps)

        # ── 생성 단계 ────────────────────────────────────────────────
        # 도구로 모은 것을 근거 블록으로 붙인다. tools는 주지 않는다.
        system = answer_system_prompt
        evidence = self._evidence_block(outcome)
        if evidence:
            system = f"{system}\n\n{evidence}"

        async for delta in solar.stream_answer(history, question, system):
            yield ("token", delta)

        yield ("outcome", outcome)

    @staticmethod
    def _collect(outcome: TurnOutcome, result: Any) -> None:
        """스킬 결과에서 라우터가 쓸 부산물을 뽑는다."""
        if not result.ok or not result.data:
            return
        srcs = result.data.get("sources")
        if isinstance(srcs, list):
            outcome.rag_sources.extend(srcs)
        figs = result.data.get("figures")
        if isinstance(figs, list):
            # figures.figure_item()의 snake_case 형태 그대로 — /retrieve 응답과
            # 같은 모양이라 프론트가 쓰던 변환을 재사용할 수 있다.
            seen = {f.get("figure_id") for f in outcome.figures}
            for f in figs:
                fid = f.get("figure_id")
                if fid and fid not in seen:
                    seen.add(fid)
                    outcome.figures.append(f)

    @staticmethod
    def _evidence_block(outcome: TurnOutcome) -> str:
        """도구가 찾아온 근거를 생성 단계 프롬프트에 붙일 블록으로.

        기존 `_WRAP_RAG` 문안과 같은 취지다 — 자료를 우선 근거로 쓰되 없는 내용은
        일반 지식으로 보완하고 출처를 구분하라는 지시.
        """
        parts: list[str] = []
        if outcome.rag_sources:
            lines = []
            for s in outcome.rag_sources:
                snippet = (s.get("snippet") or "").strip()
                if snippet:
                    lines.append(f"- [{s.get('name') or '자료'}] {snippet}")
            if lines:
                parts.append(
                    "아래는 이 질문을 위해 수업 자료에서 찾은 내용입니다. 질문과 "
                    "관련된 근거로 우선 활용하고, 자료에 없는 내용은 일반 지식으로 "
                    "보완하되 출처를 구분하세요.\n\n" + "\n".join(lines)
                )
        if outcome.figures:
            caps = [f.get("caption") or "" for f in outcome.figures]
            caps = [c for c in caps if c]
            if caps:
                parts.append(
                    "아래 교과서 도판이 학생 화면에 함께 표시됩니다. 설명할 때 "
                    "참고하되, 본문에 이미지 링크나 파일명을 쓰지 마세요.\n\n"
                    + "\n".join(f"- {c}" for c in caps)
                )
        return "\n\n".join(parts)
