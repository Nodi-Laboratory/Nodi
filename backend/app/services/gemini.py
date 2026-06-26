"""Gemini access (google-genai).

Stage 1 scope: stream a chat answer over an ancestor-chain context, and produce
a short (<=10 char intent) label for a finished (question, answer) node.
No tools / ReAct / RAG here — that is Stage 2+.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from fastapi import HTTPException, status
from google import genai
from google.genai import types

from ..config import get_settings

logger = logging.getLogger("nodi.gemini")
settings = get_settings()

# A system instruction kept deliberately generic: nodi's AI is a general
# conversational assistant; the tree is only a UX layer (no topic restriction).
_SYSTEM_INSTRUCTION = (
    "You are nodi's assistant, a helpful general-purpose conversational AI. "
    "Answer the user's latest message using the prior conversation as context. "
    "Respond in the user's language."
)

_client: genai.Client | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        if not settings.google_gemini_api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="GOOGLE_GEMINI_API_KEY is not configured.",
            )
        _client = genai.Client(api_key=settings.google_gemini_api_key)
    return _client


def _build_contents(
    history: list[tuple[str, str]], question: str
) -> list[types.Content]:
    """history = ordered [(question, answer), ...] from root to parent."""
    contents: list[types.Content] = []
    for q, a in history:
        if q:
            contents.append(
                types.Content(role="user", parts=[types.Part.from_text(text=q)])
            )
        if a:
            contents.append(
                types.Content(role="model", parts=[types.Part.from_text(text=a)])
            )
    contents.append(
        types.Content(role="user", parts=[types.Part.from_text(text=question)])
    )
    return contents


async def stream_answer(
    history: list[tuple[str, str]], question: str
) -> AsyncIterator[str]:
    """Yield answer text deltas for the SSE `token` events."""
    client = get_client()
    contents = _build_contents(history, question)
    config = types.GenerateContentConfig(system_instruction=_SYSTEM_INSTRUCTION)
    stream = await client.aio.models.generate_content_stream(
        model=settings.gemini_chat_model,
        contents=contents,
        config=config,
    )
    async for chunk in stream:
        if chunk.text:
            yield chunk.text


async def generate_label(question: str, answer: str) -> str | None:
    """Short topic label for a node. Best-effort: returns None on failure."""
    client = get_client()
    max_chars = settings.node_label_max_chars
    prompt = (
        "Summarize the topic of this Q&A as a very short label of at most "
        f"{max_chars} characters, in the same language as the question. "
        "Output ONLY the label, no quotes, no punctuation at the end.\n\n"
        f"Q: {question}\nA: {answer}"
    )
    try:
        resp = await client.aio.models.generate_content(
            model=settings.gemini_label_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                max_output_tokens=20, temperature=0.2
            ),
        )
        text = (resp.text or "").strip().strip('"').strip()
        if not text:
            return None
        # Hard-enforce the length cap (design: <=10 chars).
        return text[:max_chars]
    except Exception as exc:  # noqa: BLE001 - labeling must never break chat
        logger.warning("Label generation failed: %s", exc)
        return None
