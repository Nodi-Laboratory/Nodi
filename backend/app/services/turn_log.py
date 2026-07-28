"""Chat turn logging (D25) — Plant-Counselor LogRecorder pattern.

Accumulates one chat turn's context (system prompt, Q/A, which context blocks
were used, skill calls, errors, token estimate) and persists a single `ai_logs`
row. BEST-EFFORT: a logging failure must never break the chat turn.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from ..db.client import UserClient

logger = logging.getLogger("nodi.turn_log")


class TurnLog:
    def __init__(self, owner_id: str, session_id: str, question: str):
        self.owner_id = owner_id
        self.session_id = session_id
        self.question = question
        self.node_id: str | None = None
        self.answer: str = ""
        self.system_prompt: str | None = None
        self.contexts: dict[str, Any] = {}
        self.skill_calls: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self._history_chars = 0
        # D113 관측성 — 운영 콘솔이 읽는다.
        self.route: str | None = None
        self.model: str | None = None
        self.llm_calls: list[dict[str, Any]] = []
        self._started = time.perf_counter()

    def set_system(self, system_prompt: str | None) -> None:
        self.system_prompt = system_prompt

    def set_contexts(
        self,
        *,
        current_branch: bool,
        memory_link: bool,
        rag: bool,
        comparison: bool,
        history_chars: int = 0,
    ) -> None:
        self.contexts = {
            "current_branch": current_branch,
            "memory_link": memory_link,
            "rag": rag,
            "comparison": comparison,
        }
        self._history_chars = history_chars

    def set_contexts_structured(
        self,
        *,
        blocks: list[dict[str, Any]],
        history_turns: int = 0,
        history_chars: int = 0,
    ) -> None:
        """D35: store the STRUCTURED prompt composition.

        ``blocks`` come from ``gemini.compose_system_structured`` — each carries
        ``{kind, order, source?, raw_text?, node_ids?, sources?, prompt_span}``,
        the span being a char range into the saved ``system_prompt``. The admin
        turn-detail view (D34) highlights the prompt by these spans and lists the
        RAG ``sources`` (file·#seq·page·distance·snippet). Only blocks actually
        injected are present. The frontend distinguishes new (``blocks``) from
        legacy (boolean) logs by the presence of ``contexts.blocks``.
        """
        self.contexts = {
            "history": {"turns": history_turns, "chars": history_chars},
            "blocks": blocks,
        }
        self._history_chars = history_chars

    def add_skill(self, name: str, **detail: Any) -> None:
        self.skill_calls.append({"skill": name, **detail})

    def set_route(self, route: str, model: str | None = None) -> None:
        """어느 경로로 돈 턴인지(react|legacy)와 사용한 모델(D113)."""
        self.route = route
        self.model = model

    def set_skill_traces(self, traces: list[dict[str, Any]]) -> None:
        """오케스트레이터가 만든 스킬 트레이스로 skill_calls를 채운다(D113).

        `add_skill`과 같은 칸을 쓴다 — 콘솔이 볼 곳을 둘로 나눌 이유가 없다.
        """
        self.skill_calls = list(traces)

    def add_llm_calls(self, calls: list[dict[str, Any]]) -> None:
        self.llm_calls.extend(calls)

    def tokens(self) -> dict[str, Any]:
        """실측 토큰 사용량 합계 + 호출별 내역(D113).

        **호출이 하나도 없으면 빈 dict를 돌려준다.** 그 자리에 어림값을 넣으면
        콘솔이 추정을 실측으로 표시하게 된다 — 어림은 token_estimate 칸에
        따로 남아 있다.
        """
        if not self.llm_calls:
            return {}
        total: dict[str, Any] = {"prompt": 0, "completion": 0, "total": 0, "cached": 0}
        for call in self.llm_calls:
            for k in ("prompt", "completion", "total", "cached"):
                total[k] += int(call.get(k) or 0)
        total["calls"] = self.llm_calls
        return total

    def add_error(self, message: str) -> None:
        self.errors.append(message[:500])

    def set_final(self, node_id: str | None, answer: str) -> None:
        self.node_id = node_id
        self.answer = answer

    def _token_estimate(self) -> int:
        chars = (
            len(self.system_prompt or "")
            + self._history_chars
            + len(self.question or "")
            + len(self.answer or "")
        )
        return chars // 4  # ~4 chars/token heuristic

    def to_row(self) -> dict[str, Any]:
        return {
            "owner_id": self.owner_id,
            "session_id": self.session_id,
            "node_id": self.node_id,
            "kind": "chat",
            "system_prompt": self.system_prompt,
            "question": self.question,
            "answer": self.answer or None,
            "contexts": self.contexts,
            "skill_calls": self.skill_calls,
            "errors": self.errors,
            "token_estimate": self._token_estimate(),
            "tokens": self.tokens(),
            "route": self.route,
            "model": self.model,
            "duration_ms": int((time.perf_counter() - self._started) * 1000),
        }

    async def save(self, client: UserClient) -> None:
        """Persist the turn row (best-effort)."""
        try:
            await client.insert("ai_logs", self.to_row())
        except Exception:  # noqa: BLE001 - logging must never break chat
            logger.warning("ai_logs insert failed (best-effort); skipping")

