"""Automatic concept tagging (Stage 2 Part A).

Extract 1..3 short concept tags from a finished (question, answer) pair with a
lightweight Gemini model, then reuse-or-create them in the node's space and link
them to the node via the upsert_node_tags() RPC (migration 0005).

Everything here is BEST-EFFORT: tagging must never break chat. Failures return
empty / are swallowed with a server-side log.
"""

from __future__ import annotations

import json
import logging

from google.genai import types

from ..config import get_settings
from .gemini import get_client
from .supabase_client import UserClient

logger = logging.getLogger("nodi.tagging")
settings = get_settings()

_TAG_PROMPT = (
    "Extract the {max_tags} most important CONCEPTS discussed in this Q&A as "
    "short noun phrases (1-3 words each), in the same language as the text. "
    "Rules: between 1 and {max_tags} tags; prefer specific, meaningful concepts "
    "over generic words (avoid words like 'question', 'answer', 'explanation', "
    "'information'); no duplicates; no surrounding punctuation. "
    'Return ONLY a JSON array of strings, e.g. ["광합성","엽록체"].\n\n'
    "Q: {question}\nA: {answer}"
)


def _parse_tags(raw: str, max_tags: int) -> list[str]:
    """Parse the model's JSON array into a clean, deduped, capped list."""
    text = (raw or "").strip()
    # Tolerate code fences if the model adds them.
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("[") :] if "[" in text else text
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in data:
        if not isinstance(item, str):
            continue
        name = item.strip().strip('"').strip()
        if not name or len(name) > 40:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(name)
        if len(out) >= max_tags:
            break
    return out


async def extract_concepts(question: str, answer: str) -> list[str]:
    """Return 1..max_tags concept strings (empty list on any failure)."""
    max_tags = settings.max_tags_per_node
    prompt = _TAG_PROMPT.format(
        max_tags=max_tags, question=question, answer=answer
    )
    try:
        client = get_client()
        resp = await client.aio.models.generate_content(
            model=settings.gemini_tag_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                max_output_tokens=120,
                temperature=0.2,
            ),
        )
        return _parse_tags(resp.text or "", max_tags)
    except Exception as exc:  # noqa: BLE001 - tagging must never break chat
        logger.warning("Concept extraction failed: %s", exc)
        return []


_FILE_TAG_PROMPT = (
    "Extract up to {max_tags} key CONCEPTS from the document excerpt below as "
    "short noun phrases (1-3 words each), in the document's language. Files are "
    "tagged densely (many concepts). Rules: specific, meaningful concepts only "
    "(avoid generic words like 'document', 'introduction', 'information'); no "
    "duplicates; no surrounding punctuation. Return ONLY a JSON array of "
    "strings.\n\nDocument excerpt:\n{text}"
)


async def extract_file_concepts(text: str) -> list[str]:
    """Extract up to file_tag_max concept strings from file text (best-effort)."""
    max_tags = settings.file_tag_max
    excerpt = (text or "").strip()[: settings.file_tag_sample_chars]
    if not excerpt:
        return []
    prompt = _FILE_TAG_PROMPT.format(max_tags=max_tags, text=excerpt)
    try:
        client = get_client()
        resp = await client.aio.models.generate_content(
            model=settings.gemini_tag_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                max_output_tokens=1000,
                temperature=0.3,
            ),
        )
        return _parse_tags(resp.text or "", max_tags)
    except Exception as exc:  # noqa: BLE001 - tagging must never break indexing
        logger.warning("File concept extraction failed: %s", exc)
        return []


async def apply_node_tags(
    client: UserClient, node_id: str, session_id: str, names: list[str]
) -> list[str]:
    """Reuse-or-create tags and link to the node. Returns stored tag names."""
    if not names:
        return []
    result = await client.rpc(
        "upsert_node_tags",
        {"p_node_id": node_id, "p_session_id": session_id, "p_names": names},
    )
    # RPC returns text[] (the stored names attached).
    if isinstance(result, list):
        return [n for n in result if isinstance(n, str)]
    return []


async def tag_node(
    client: UserClient, node_id: str, session_id: str, question: str, answer: str
) -> list[str]:
    """Full best-effort pipeline: extract -> upsert/link. Never raises."""
    try:
        names = await extract_concepts(question, answer)
        return await apply_node_tags(client, node_id, session_id, names)
    except Exception:  # noqa: BLE001
        logger.exception("Tagging failed for node=%s", node_id)
        return []
