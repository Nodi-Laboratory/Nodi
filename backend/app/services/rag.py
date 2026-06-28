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


def _branch_query_text(chain: list[dict[str, Any]]) -> str:
    """Use the tail of the branch (recent Q&A) as the suggestion query."""
    parts: list[str] = []
    for n in reversed(chain):
        if n.get("is_navigator"):
            continue
        q = (n.get("question") or "").strip()
        a = (n.get("answer") or "").strip()
        if q or a:
            parts.append(f"{q}\n{a}")
        if len("\n".join(parts)) >= settings.file_suggestion_query_chars:
            break
    text = "\n".join(reversed(parts))
    return text[: settings.file_suggestion_query_chars]


async def suggest_files(
    client: UserClient,
    chain: list[dict[str, Any]],
    space_kind: str,
    space_ref: str,
) -> list[dict[str, Any]]:
    """Propose files to link when the current branch has NONE linked yet.

    Returns top-N files (grouped by best chunk distance) with a sample chunk.
    Empty if the branch already has linked files or the space has no indexed
    files. Best-effort.
    """
    try:
        # Already has linked files on this branch -> no suggestion.
        if await linked_file_ids(client, chain):
            return []
        # Indexed files available in this space (own + class_material via RLS).
        files = await client.select(
            "files",
            {
                "space_kind": f"eq.{space_kind}",
                "space_ref": f"eq.{space_ref}",
                "status": "eq.indexed",
                "select": "id,storage_path,mime,kind",
            },
        )
        if not files:
            return []
        by_id = {f["id"]: f for f in files}
        query = _branch_query_text(chain)
        if not query.strip():
            return []
        chunks = await search(
            client, list(by_id), query, k=settings.file_suggestion_search_k
        )
        # Group chunks by file, keep best (smallest) distance + a sample.
        best: dict[str, dict[str, Any]] = {}
        for c in chunks:
            fid = c.get("file_id")
            if fid not in by_id:
                continue
            dist = c.get("distance")
            cur = best.get(fid)
            if cur is None or (dist is not None and dist < cur["distance"]):
                best[fid] = {
                    "file_id": fid,
                    "distance": dist if dist is not None else 1.0,
                    # filename from storage_path "{owner}/{file_id}/{name}".
                    "name": (by_id[fid].get("storage_path") or "").split("/")[-1],
                    "sample": (c.get("chunk_text") or "")[:300],
                    "kind": by_id[fid].get("kind"),
                }
        # Only suggest genuinely-related files (cosine distance cutoff), so we
        # don't claim "관련 있어 보여요" for unrelated material.
        max_distance = getattr(settings, "file_suggestion_max_distance", 0.75)
        ranked = sorted(
            (b for b in best.values() if b["distance"] <= max_distance),
            key=lambda x: x["distance"],
        )
        return ranked[: settings.file_suggestion_top_n]
    except Exception:  # noqa: BLE001 - suggestions are optional
        logger.exception("File suggestion failed")
        return []
