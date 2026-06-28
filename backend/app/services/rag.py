"""Visual RAG retrieval + chat injection (Stage 3b-2).

A file linked to a node applies to that node and its descendant branch. At chat
time we collect the files linked anywhere on the current head's ancestor chain,
embed the question (RETRIEVAL_QUERY, 768), cosine-search those files' chunks
(pgvector, owner-scoped), and inject the top-K chunks as a SOURCE-LABELLED
reference block ("[연결된 자료에서 참고]") distinct from the live branch and the
Stage-3a memory-link block.

Best-effort: any failure -> no RAG context, never blocks the turn. Reads use the
caller's RLS-scoped client (own files only).
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from . import embedding
from .supabase_client import UserClient

logger = logging.getLogger("nodi.rag")
settings = get_settings()


def _vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{v:.7f}" for v in vec) + "]"


async def linked_file_ids(
    client: UserClient, chain: list[dict[str, Any]]
) -> list[str]:
    """File ids linked to any node on the current branch (head -> root)."""
    node_ids = [n["id"] for n in chain]
    if not node_ids:
        return []
    rows = await client.select(
        "file_node_links",
        {
            "target_node_id": f"in.({','.join(node_ids)})",
            "select": "file_id",
        },
    )
    seen: list[str] = []
    for r in rows:
        fid = r.get("file_id")
        if fid and fid not in seen:
            seen.append(fid)
    return seen


async def search(
    client: UserClient, file_ids: list[str], query: str, k: int | None = None
) -> list[dict[str, Any]]:
    """Cosine top-K chunks from the given (owned) files for the query."""
    if not file_ids or not query.strip():
        return []
    k = k or settings.rag_top_k
    vec = await embedding.embed_texts([query], task_type="RETRIEVAL_QUERY")
    if not vec:
        return []
    result = await client.rpc(
        "search_file_chunks",
        {
            "p_query_embedding": _vector_literal(vec[0]),
            "p_file_ids": file_ids,
            "p_k": k,
        },
    )
    return result if isinstance(result, list) else []


def build_block(chunks: list[dict[str, Any]]) -> str:
    """Render retrieved chunks as a labelled reference block."""
    if not chunks:
        return ""
    lines = ["[연결된 자료에서 참고]"]
    for c in chunks:
        text = (c.get("chunk_text") or "").strip()
        if text:
            lines.append(f"- {text}")
    return "\n".join(lines) if len(lines) > 1 else ""


async def build_rag_context(
    client: UserClient, chain: list[dict[str, Any]], query: str
) -> str | None:
    """Best-effort: assemble the linked-file reference block, or None."""
    try:
        file_ids = await linked_file_ids(client, chain)
        if not file_ids:
            return None
        chunks = await search(client, file_ids, query)
        block = build_block(chunks)
        return block or None
    except Exception:  # noqa: BLE001 - RAG must never break chat
        logger.exception("RAG retrieval failed")
        return None
