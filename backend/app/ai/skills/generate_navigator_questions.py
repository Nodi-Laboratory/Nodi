"""Skill: generate_navigator_questions.

Given a branch summary (the ancestor-chain Q&A) and the branch's shared concept
tags, propose a few related follow-up questions that deepen or branch the
current topic. Read-only (no DB writes). Returns {"questions": [...]}.
"""

from __future__ import annotations

import json
import logging

from google.genai import types

from ...config import get_settings
from ...services.gemini import get_client
from .base import Skill

logger = logging.getLogger("nodi.ai.navigator_skill")
settings = get_settings()

_PROMPT = (
    "You are nodi's navigator. Based on the conversation branch below and its "
    "key concepts, propose exactly {n} SHORT follow-up questions (in the same "
    "language as the conversation) that a curious learner would naturally ask "
    "next — to deepen, contrast, or extend the topic. Make them specific and "
    "distinct from each other; do not repeat questions already asked.\n"
    'Return ONLY a JSON array of {n} strings.\n\n'
    "Key concepts: {tags}\n\n"
    "Conversation branch (oldest first):\n{branch}"
)


def _format_branch(branch: list[tuple[str, str]]) -> str:
    lines: list[str] = []
    for q, a in branch:
        if q:
            lines.append(f"Q: {q}")
        if a:
            # keep the prompt compact
            lines.append(f"A: {a[:400]}")
    return "\n".join(lines) if lines else "(empty)"


def _parse(raw: str, n: int) -> list[str]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("[") :] if "[" in text else text
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    out: list[str] = []
    for item in data:
        if isinstance(item, str) and item.strip():
            out.append(item.strip().strip('"').strip())
        if len(out) >= n:
            break
    return out


async def run(
    *,
    branch: list[tuple[str, str]],
    tags: list[str],
    count: int | None = None,
    **_: object,
) -> dict:
    n = count or settings.navigator_question_count
    prompt = _PROMPT.format(
        n=n,
        tags=", ".join(tags) if tags else "(none)",
        branch=_format_branch(branch),
    )
    client = get_client()
    resp = await client.aio.models.generate_content(
        model=settings.gemini_navigator_model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            # Disable "thinking" (on by default for 2.5-flash) so the token
            # budget produces the answer, not internal reasoning.
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            max_output_tokens=600,
            temperature=0.7,
        ),
    )
    tokens = None
    usage = getattr(resp, "usage_metadata", None)
    if usage is not None:
        tokens = getattr(usage, "total_token_count", None)
    return {"questions": _parse(resp.text or "", n), "tokens": tokens}


SKILL = Skill(
    name="generate_navigator_questions",
    description=(
        "Propose related follow-up questions for the current conversation "
        "branch, using its shared concept tags. Read-only."
    ),
    run=run,
    writes=False,
)
