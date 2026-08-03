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
import time
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

- 학생이 **무언가를 묻고 있으면** 네가 답을 안다고 생각하더라도 최소한
  자료 검색 도구는 부른다. 이 제품은 선생님이 올린 수업 자료·교과서에 근거해
  답하는 것이 전제다 — 네 일반 지식으로 답하면 그 근거가 사라진다.
- 인사·잡담·감사 인사처럼 **묻는 것이 없으면** 아무 도구도 부르지 마라.
- 도구를 부를 때는 학생의 표현을 그대로 검색어로 써도 된다.
- 여러 개념을 묻는 복합 질문(비교·차이·원인과 결과 등)은 **서브질문으로 나눠 각각 검색**하라.
- 개념을 설명해 달라는 질문이면 자료 검색과 **함께** 강의 영상·교과서 도판 도구도 부른다
  (목록에 보일 때만 있다). 학생 화면에 곁들여 뜨는 것이라 답을 방해하지 않는다.
- 검색 결과가 질문의 일부만 덮으면, 부족한 부분을 다른 검색어로 다시 찾아라.
- 도구를 부르지 않기로 했다면 아주 짧게 한 마디만 하고 끝낸다(이 텍스트는 학생에게 보이지 않는다).
"""


@dataclass
class TurnOutcome:
    """루프가 끝난 뒤 라우터가 쓰는 부산물."""

    # 자료 검색 스킬이 만든 출처 — 답변 노드에 실어 출처 칩으로 쓴다(D32/D74).
    rag_sources: list[dict[str, Any]] = field(default_factory=list)
    # 도판 검색 스킬이 만든 항목 — 캔버스 리프로 띄우고 attachments에 영속한다.
    figures: list[dict[str, Any]] = field(default_factory=list)
    # 강의 클립 검색 스킬이 만든 항목 — figures와 대칭, clip_id로 dedupe(D149).
    clips: list[dict[str, Any]] = field(default_factory=list)
    # 실행된 스킬 이름(로그·관측성).
    used_skills: list[str] = field(default_factory=list)
    # 스킬이 돌려준 내용 그대로 — 생성 단계 프롬프트에 근거로 붙는다.
    # `(스킬 이름, 메시지, data)`.
    findings: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)
    # 생성 단계에 **실제로 보낸** 시스템 프롬프트(근거 블록 포함).
    #
    # D112: 라우터의 TurnLog는 근거 블록이 붙기 전 프롬프트를 저장한다. 그러면
    # admin 로그가 실제 보낸 것과 달라진다 — D35의 "저장한 프롬프트와 실제가
    # 어긋나지 않는다"는 계약이 ReAct 경로에서만 깨져 있었다. 라우터가 이 값으로
    # 덮어쓴다.
    final_system: str = ""
    # D113: 스킬 호출 트레이스. `used_skills`는 이름만이라 "왜 그 답이 나왔나"를
    # 되짚을 수 없었다 — 운영 콘솔이 인자·결과·소요시간까지 보여주려면 여기
    # 담아야 한다. 스킬 **설명**은 담지 않는다: 매 턴 같은 문자열을 복제하는
    # 낭비이고, 콘솔이 /admin/skills 카탈로그와 이름으로 이어 붙인다.
    skill_traces: list[dict[str, Any]] = field(default_factory=list)
    # D113: LLM 호출별 실측 usage — `[{stage, model, prompt, completion, ...}]`.
    llm_calls: list[dict[str, Any]] = field(default_factory=list)


# 전용 렌더가 이미 담는 키 — 일반 렌더에서 중복으로 싣지 않는다.
_HANDLED_KEYS = frozenset({"sources", "figures", "captions", "chunks", "clips"})

# 근거가 **아닌** 스킬. 결과가 조회한 사실이 아니라 모델 자신의 산출물이다.
#
# `think`는 모델이 세운 계획을 그대로 돌려준다. 그걸 근거 블록에 실으면
# "방금 도구로 확인한 실제 데이터"라는 문구와 함께 자기 추측이 되돌아온다 —
# 모델이 자기 계획을 검증된 사실로 취급하게 만드는 셈이다. 계획은 판단 단계의
# 대화 이력(tool_result)에만 남기면 충분하다.
_NOT_EVIDENCE = frozenset({"think"})

# 화면에 **곁들여 띄우는** 것들 (D163). 답을 바꾸지 않고 옆에 붙기만 한다.
# `(스킬 이름, 이미 건졌는가)` — 건진 게 없으면 모델이 불렀더라도 다시 부른다.
_RECOMMEND_SKILLS: tuple[tuple[str, str], ...] = (
    ("search_textbook_figure", "figures"),
    ("search_lecture_clip", "clips"),
)
# 일반 렌더 1건의 길이 상한. 스킬이 큰 목록을 돌려줘도 프롬프트가 폭주하지 않게.
_GENERIC_MAX_CHARS = 4000

# D113: 트레이스에 싣는 스킬 결과의 상한. 파일 전문을 돌려주는 스킬(read_session_file)이
# 있어 상한이 없으면 로그 행 하나가 수만 자가 된다.
_TRACE_MAX_CHARS = 4000


def _trace_data(data: dict[str, Any] | None) -> dict[str, Any]:
    """스킬 결과를 로그에 실을 형태로. 작으면 그대로, 크면 잘라서 알린다.

    자른 사실을 `_truncated`로 남긴다 — 조용히 자르면 관리자가 "스킬이 이만큼만
    돌려줬다"고 오해한다.
    """
    if not data:
        return {}
    body = json.dumps(data, ensure_ascii=False, default=str)
    if len(body) <= _TRACE_MAX_CHARS:
        return data
    return {
        "_truncated": True,
        "_chars": len(body),
        "_keys": sorted(data),
        "_preview": body[:_TRACE_MAX_CHARS],
    }


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
            for step in range(max_steps):
                try:
                    completion = await solar.complete(
                        messages, tools=catalog, max_tokens=512
                    )
                except Exception:  # noqa: BLE001 - 판단 실패가 턴을 죽이지 않는다
                    logger.exception("도구 판단 호출 실패 — 도구 없이 진행한다")
                    break
                msg = completion.message
                outcome.llm_calls.append(
                    {"stage": "decide", "step": step, **completion.usage}
                )

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

                # D112: 한 스텝에 **같은 호출이 여러 번** 오는 일이 있다(모델이
                # 같은 도구를 중복 요청). 그대로 실행하면 임베딩·검색 비용이
                # 그만큼 늘어난다. 이름+인자가 같으면 한 번만 돌린다.
                seen_calls: set[tuple[str, str]] = set()
                for call in tool_calls:
                    fn = call.get("function") or {}
                    name = fn.get("name") or ""
                    raw_args = fn.get("arguments") or "{}"
                    try:
                        args = json.loads(raw_args)
                    except json.JSONDecodeError:
                        args = {}
                    if not isinstance(args, dict):
                        args = {}

                    key = (name, json.dumps(args, sort_keys=True, ensure_ascii=False))
                    if key in seen_calls:
                        logger.info("중복 도구 호출 생략: %s", name)
                        # 생략도 트레이스에 남긴다 — 모델이 같은 호출을 반복하는
                        # 버릇은 콘솔에서 보여야 고칠 수 있다.
                        outcome.skill_traces.append(
                            {
                                "skill": name,
                                "step": step,
                                "args": args,
                                "ok": True,
                                "skipped": True,
                                "message": "같은 요청이라 생략했습니다.",
                                "duration_ms": 0,
                            }
                        )
                        # 모델이 결과를 기다리므로 tool_result는 반드시 돌려준다 —
                        # 빠뜨리면 대화 형식이 깨져 다음 호출이 실패한다.
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": call.get("id") or name,
                                "content": json.dumps(
                                    {"ok": True, "message": "같은 요청이라 생략했습니다."},
                                    ensure_ascii=False,
                                ),
                            }
                        )
                        continue
                    seen_calls.add(key)

                    yield ("sse", _sse("tool_call", {"name": name, "args": args}))

                    started = time.perf_counter()
                    result = await self.registry.dispatch(name, args, ctx)
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    outcome.used_skills.append(name)
                    outcome.skill_traces.append(
                        {
                            "skill": name,
                            "step": step,
                            "args": args,
                            "ok": result.ok,
                            "message": result.message,
                            "error_code": result.error_code,
                            "duration_ms": elapsed_ms,
                            "data": _trace_data(result.data),
                        }
                    )
                    self._collect(outcome, name, result)

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
        # 라우터가 TurnLog에 **실제 보낸 것**을 남길 수 있게 넘긴다(D112).
        outcome.final_system = system

        answer_usage: dict[str, int] = {}
        answer_parts: list[str] = []
        async for delta in solar.stream_answer(
            history, question, system, usage_sink=answer_usage
        ):
            answer_parts.append(delta)
            yield ("token", delta)
        # 스트림이 끊기면 usage 청크가 안 올 수 있다 — 빈 채로 두고 어림하지
        # 않는다(실측 자리에 추정을 앉히면 둘을 구분할 수 없다).
        if answer_usage:
            outcome.llm_calls.append({"stage": "answer", **answer_usage})

        # ── 곁들이 보장 ──────────────────────────────────────────────
        #
        # D163. 학생 화면에 **곁들여 뜨는 것**(EBS 강의 클립·교과서 도판)은
        # 모델의 도구 선택에 맡기면 안 뜬다. 실측(2026-08-03):
        #
        #   "실험실에서 안전하게 실험하려면?"  → search_class_material만 호출
        #   "정확도랑 정밀도 차이가 뭐야?"     → 도구 0건 (안다고 생각해서)
        #
        # 둘 다 학급에 켜 둔 강의 클립이 거리 0.49로 걸리는 질문이었다. 선생님이
        # 올려 둔 것이 학생 화면에 영영 안 뜨는 셈이다. D135가 같은 결론에 이미
        # 도달했다 — "선택 스킬에 맡기면 모델이 안 불러서 보장이 깨진다."
        #
        # ## 언제 도는가 — 개념 카드가 나온 턴에만
        #
        # 인사·잡담 턴에는 임베딩·검색이 **아예 나가지 않아야 한다**(CLAUDE.md).
        # 판단 단계의 도구 호출 여부로는 그 둘을 못 가른다(위 두 번째 실측이
        # 도구 0건이었다). 그래서 **생성 결과**를 신호로 쓴다: 개념 카드가
        # 만들어졌다면 학생이 뭔가를 배운 턴이고, 인사면 카드가 없다.
        #
        # 판정은 이미 있는 파서를 그대로 쓴다 — 개념 카드 형식을 읽는 네 번째
        # 구현을 만들면 반드시 어긋난다(CLAUDE.md).
        answer = "".join(answer_parts)
        catalog_names = {c.get("function", {}).get("name") for c in catalog}
        if solar.extract_used_tags([{"answer": answer}]):
            for name, bucket in _RECOMMEND_SKILLS:
                if name not in catalog_names or getattr(outcome, bucket):
                    continue
                # 모델이 **같은 검색어로** 이미 해 봤으면 다시 하지 않는다.
                # 다른 검색어였다면 한 번 더 해 본다 — 실측(2026-08-03)에서
                # 모델이 "측정 표준이 왜 필요해?"를 "측정 표준의 필요성"으로
                # 다듬어 부르는 바람에 0건이었는데, 원문으로는 걸렸다.
                tried = {
                    (t.get("args") or {}).get("query")
                    for t in outcome.skill_traces
                    if t.get("skill") == name
                }
                if question in tried:
                    continue
                yield ("sse", _sse("tool_call", {"name": name, "args": {"query": question}}))
                started = time.perf_counter()
                result = await self.registry.dispatch(name, {"query": question}, ctx)
                outcome.used_skills.append(name)
                outcome.skill_traces.append(
                    {
                        "skill": name,
                        "step": -1,          # 모델이 아니라 시스템이 부른 호출
                        "args": {"query": question},
                        "ok": result.ok,
                        "message": result.message,
                        "error_code": result.error_code,
                        "duration_ms": int((time.perf_counter() - started) * 1000),
                        "auto": True,
                        "data": _trace_data(result.data),
                    }
                )
                self._collect(outcome, name, result)
                yield (
                    "sse",
                    _sse(
                        "tool_result",
                        {"name": name, "ok": result.ok, "message": result.message},
                    ),
                )

        yield ("outcome", outcome)

    @staticmethod
    def _collect(outcome: TurnOutcome, name: str, result: Any) -> None:
        """스킬 결과에서 라우터·생성 단계가 쓸 것을 뽑는다."""
        if not result.ok:
            return
        outcome.findings.append((name, result.message, dict(result.data or {})))
        if not result.data:
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
        # D149: 강의 클립 — figures와 같은 방식으로 clip_id 중복만 걸러 누적한다.
        clips = result.data.get("clips")
        if isinstance(clips, list):
            seen_clips = {c.get("clip_id") for c in outcome.clips}
            for c in clips:
                cid = c.get("clip_id")
                if cid and cid not in seen_clips:
                    seen_clips.add(cid)
                    outcome.clips.append(c)

    @staticmethod
    def _evidence_block(outcome: TurnOutcome) -> str:
        """도구가 찾아온 것을 생성 단계 프롬프트에 붙일 근거 블록으로.

        **모든 스킬 결과가 여기를 통과해야 한다.** 예전에는 rag_sources와
        figures만 렌더해서 그 외 스킬의 결과가 생성 단계에 도달하지 못했다 —
        모델이 도구를 부르고도 아무것도 못 본 채 그럴듯한 답을 지어냈다
        (2026-07-28 실측: `summarize_class_questions`가 실제 질문 16건을
        돌려줬는데 답변은 "시험 범위 질문이 많다"는 창작이었다).
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
        if outcome.clips:
            # D149: 추천 강의 클립 — 제목·타임라인을 근거로 붙인다(figures 대칭).
            clip_lines = []
            for c in outcome.clips:
                title = c.get("title")
                if title:
                    clip_lines.append(
                        f"- 강의 클립: {title} ({c.get('timeline_label', '')})"
                    )
            if clip_lines:
                parts.append(
                    "아래 강의 클립이 학생 화면에 함께 추천됩니다. 설명할 때 "
                    "참고하되, 본문에 링크를 쓰지 마세요.\n\n" + "\n".join(clip_lines)
                )

        # 나머지 스킬 결과 — 전용 렌더가 이미 담은 키만 빼고 그대로 보여 준다.
        generic: list[str] = []
        for name, message, data in outcome.findings:
            if name in _NOT_EVIDENCE:
                continue
            rest = {
                k: v
                for k, v in data.items()
                if k not in _HANDLED_KEYS and v not in (None, [], "", {})
            }
            if not rest:
                continue
            body = json.dumps(rest, ensure_ascii=False, default=str)
            if len(body) > _GENERIC_MAX_CHARS:
                body = body[:_GENERIC_MAX_CHARS] + "…(생략)"
            generic.append(f"[{name}] {message}\n{body}")
        if generic:
            parts.append(
                "아래는 방금 도구로 확인한 **실제 데이터**입니다. 여기 있는 것만 "
                "근거로 삼고 없는 내용을 지어내지 마세요. 비어 있으면 없다고 "
                "솔직히 말하세요.\n\n" + "\n\n".join(generic)
            )
        return "\n\n".join(parts)
