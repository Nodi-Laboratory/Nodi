"""Gemini access (google-genai).

Stage 1 scope: stream a chat answer over an ancestor-chain context, and produce
a short (<=10 char intent) label for a finished (question, answer) node.
No tools / ReAct / RAG here — that is Stage 2+.
"""

from __future__ import annotations

import json
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


def _system_instruction(
    reference_context: str | None,
    rag_context: str | None = None,
    comparison_context: str | None = None,
) -> str:
    """Base instruction plus SOURCE-LABELLED reference blocks (kept out of the
    live ancestor-chain turns so the model treats them as separate reference):

    - `reference_context`: imported other-branch content (Stage 3a memory link).
    - `rag_context`: chunks from files linked to the branch (Stage 3b-2 RAG).
    - `comparison_context`: one-time referenced branches for comparison (D15).
    """
    parts = [_SYSTEM_INSTRUCTION]
    if reference_context:
        parts.append(
            "아래는 사용자가 다른 대화 분기에서 끌어온 참고 자료입니다. 현재 분기 "
            "대화와 출처를 구분해 활용하되, 답변에 자연스럽게 반영하세요. 현재 "
            "분기에서 실제로 오간 대화가 아님에 유의하세요.\n\n" + reference_context
        )
    if rag_context:
        parts.append(
            "아래는 사용자가 이 분기에 연결한 자료에서 검색된 내용입니다. 질문과 "
            "관련된 근거로 우선 활용하고, 자료에 없는 내용은 일반 지식으로 보완하되 "
            "출처를 구분하세요.\n\n" + rag_context
        )
    if comparison_context:
        parts.append(
            "아래는 사용자가 이번 질문에서만 비교 목적으로 참조한 다른 분기들의 "
            "내용입니다. 현재 분기와 비교/대조해 답하되, 출처를 구분하세요.\n\n"
            + comparison_context
        )
    return "\n\n".join(parts)


# Public alias so callers (e.g. turn logging) can capture the exact system
# prompt that stream_answer will use.
def compose_system_instruction(
    reference_context: str | None,
    rag_context: str | None = None,
    comparison_context: str | None = None,
) -> str:
    return _system_instruction(reference_context, rag_context, comparison_context)


async def stream_answer(
    history: list[tuple[str, str]],
    question: str,
    reference_context: str | None = None,
    rag_context: str | None = None,
    comparison_context: str | None = None,
) -> AsyncIterator[str]:
    """Yield answer text deltas for the SSE `token` events.

    `reference_context` = imported other-branch content (Stage 3a).
    `rag_context` = chunks from files linked to the branch (Stage 3b-2).
    `comparison_context` = one-time referenced branches for comparison (D15).
    All are injected separately from the live ancestor chain.
    """
    client = get_client()
    contents = _build_contents(history, question)
    config = types.GenerateContentConfig(
        system_instruction=_system_instruction(
            reference_context, rag_context, comparison_context
        )
    )
    stream = await client.aio.models.generate_content_stream(
        model=settings.gemini_chat_model,
        contents=contents,
        config=config,
    )
    async for chunk in stream:
        if chunk.text:
            yield chunk.text


_OCR_PROMPT = (
    "Extract ALL readable text from this image, preserving reading order and "
    "line/paragraph breaks. Output ONLY the extracted text (no commentary). "
    "If there is no readable text, output nothing."
)


async def ocr_image_bytes(data: bytes, mime: str) -> str:
    """OCR an image with the multimodal model. Returns '' on failure/empty."""
    try:
        client = get_client()
        resp = await client.aio.models.generate_content(
            model=settings.ocr_model,
            contents=[
                types.Part.from_bytes(data=data, mime_type=mime),
                types.Part.from_text(text=_OCR_PROMPT),
            ],
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        return (resp.text or "").strip()
    except Exception as exc:  # noqa: BLE001 - OCR failure surfaces as empty text
        logger.warning("Image OCR failed: %s", exc)
        return ""


async def generate_label(question: str, answer: str) -> str | None:
    """Short topic label for a node. Best-effort: returns None on failure."""
    client = get_client()
    max_chars = settings.node_label_max_chars
    prompt = (
        "LANGUAGE RULE (most important): write the label in the SAME language as "
        "the QUESTION below. Do NOT translate to any other language.\n"
        "Summarize the topic of this Q&A as a very short label of at most "
        f"{max_chars} characters. Output ONLY the label, no quotes, no "
        "punctuation at the end.\n\n"
        f"Q: {question}\nA: {answer}"
    )
    try:
        resp = await client.aio.models.generate_content(
            model=settings.gemini_label_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                max_output_tokens=20, temperature=0.0
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


# ---------------------------------------------------------------------------
# Overseer (home, linear context) — architecture §7
# ---------------------------------------------------------------------------
_OVERSEER_INSTRUCTION = (
    "You are nodi's overseer — the assistant on the home screen. You do NOT "
    "answer the topic in depth; instead you help the user NAVIGATE their "
    "workspaces and decide where to take a question. Use the workspace snapshot "
    "below (spaces, recent sessions, top concepts, topic matches) to give a "
    "short, friendly reply in the user's language. If the user asks a "
    "substantive/concept question, suggest starting a NEW conversation for it; "
    "if it relates to an existing session, point them there. Keep it concise; "
    "the concrete buttons are provided separately by the app."
)


async def stream_overseer(snapshot: str, message: str) -> AsyncIterator[str]:
    """Stream the overseer's short navigational reply (token events)."""
    client = get_client()
    system = _OVERSEER_INSTRUCTION + "\n\n[워크스페이스 스냅샷]\n" + snapshot
    contents = [
        types.Content(role="user", parts=[types.Part.from_text(text=message)])
    ]
    stream = await client.aio.models.generate_content_stream(
        model=settings.gemini_chat_model,
        contents=contents,
        config=types.GenerateContentConfig(
            system_instruction=system,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            max_output_tokens=600,
        ),
    )
    async for chunk in stream:
        if chunk.text:
            yield chunk.text


def _parse_json_array(raw: str, n: int) -> list[str]:
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


async def generate_home_suggestions(
    concepts: list[str], recent_titles: list[str], count: int
) -> list[str]:
    """Propose `count` starter questions from the user's concepts/activity.

    Best-effort: returns [] on failure (home still renders without suggestions).
    """
    prompt = (
        f"Propose exactly {count} SHORT, engaging starter questions a learner "
        "might want to explore next, in the user's language. Base them on the "
        "user's frequent concepts and recent activity. Make them specific and "
        "distinct. Return ONLY a JSON array of strings.\n\n"
        f"Frequent concepts: {', '.join(concepts) if concepts else '(none)'}\n"
        f"Recent sessions: {', '.join(recent_titles) if recent_titles else '(none)'}"
    )
    try:
        client = get_client()
        resp = await client.aio.models.generate_content(
            model=settings.gemini_navigator_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                thinking_config=types.ThinkingConfig(thinking_budget=0),
                max_output_tokens=400,
                temperature=0.8,
            ),
        )
        return _parse_json_array(resp.text or "", count)
    except Exception as exc:  # noqa: BLE001 - suggestions are optional
        logger.warning("Home suggestion generation failed: %s", exc)
        return []
