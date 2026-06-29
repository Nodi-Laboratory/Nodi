"""Background embedding worker (Stage 3b-1).

apscheduler polls `jobs(status='queued')` and processes them with the
service-role client (RLS bypass). Disabled when no service-role key.

Job flow (architecture §5, D11 — split then parallel batches):
  embedding_split:  download file -> extract text (PDF/txt) -> chunk ->
                    insert file_chunks(pending) + set chunk_total, status=
                    'embedding' -> create embedding_batch child jobs.
  embedding_batch:  embed the batch's chunks (Gemini, normalized) -> fill
                    embeddings + status='embedded', recompute file progress;
                    when all chunks resolved -> file status 'indexed' (or
                    'partial' if some failed).

Concurrency: each poll claims up to `embedding_worker_concurrency` queued jobs
and runs them concurrently. Claiming flips status queued->running conditionally
so a job is processed once.
"""

from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from ..config import get_settings
from . import app_settings, embedding, gemini, tagging
from .service_client import ServiceClient, get_service_client

logger = logging.getLogger("nodi.embedding_worker")
settings = get_settings()

_scheduler: AsyncIOScheduler | None = None
_poll_lock = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Text extraction: PDF (pypdf), plain text, and image OCR (Gemini vision).
# Scanned-PDF page-render OCR is a follow-up (Stage 3b-3 covers image/* only).
# ---------------------------------------------------------------------------
async def _extract_text(data: bytes, mime: str | None, storage_path: str) -> str:
    name = (storage_path or "").lower()
    mime = mime or ""

    if mime.startswith("image/") or name.endswith(
        (".png", ".jpg", ".jpeg", ".webp", ".gif")
    ):
        return await gemini.ocr_image_bytes(data, mime or "image/png")

    if name.endswith(".pdf") or mime.endswith("pdf"):
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(data))
            return "\n\n".join((p.extract_text() or "") for p in reader.pages)
        except Exception:  # noqa: BLE001
            logger.exception("PDF text extraction failed for %s", storage_path)
            return ""

    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="ignore")


def _vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{v:.7f}" for v in vec) + "]"


# ---------------------------------------------------------------------------
# Job claiming
# ---------------------------------------------------------------------------
async def _claim_jobs(svc: ServiceClient, limit: int) -> list[dict[str, Any]]:
    queued = await svc.select(
        "jobs",
        {
            "status": "eq.queued",
            "select": "id,kind,target_id,batch_range,owner_id,attempts,space_ref",
            "order": "created_at.asc",
            "limit": str(limit),
        },
    )
    claimed: list[dict[str, Any]] = []
    for job in queued:
        rows = await svc.update(
            "jobs",
            {"id": f"eq.{job['id']}", "status": "eq.queued"},
            {
                "status": "running",
                "attempts": (job.get("attempts") or 0) + 1,
                "updated_at": _now_iso(),
            },
        )
        if rows:  # we won the claim
            claimed.append(rows[0])
    return claimed


async def _recover_stale_jobs(svc: ServiceClient) -> int:
    """Reclaim jobs stuck in 'running' from a crashed worker.

    A running job whose updated_at is older than `embedding_stale_seconds` is
    orphaned. If attempts remain, requeue it; otherwise mark it failed and set
    the file to a terminal status (split -> failed; batch -> partial via
    finalize). updated_at is stamped at claim, so a live in-flight job (the poll
    awaits its jobs before returning) is never seen as stale.
    """
    cutoff = (
        datetime.now(timezone.utc)
        - timedelta(seconds=settings.embedding_stale_seconds)
    ).isoformat()
    stale = await svc.select(
        "jobs",
        {
            "status": "eq.running",
            "updated_at": f"lt.{cutoff}",
            "select": "id,kind,target_id,attempts,batch_range",
            "limit": "50",
        },
    )
    for job in stale:
        if (job.get("attempts") or 0) < settings.embedding_max_attempts:
            await svc.update(
                "jobs",
                {"id": f"eq.{job['id']}", "status": "eq.running"},
                {"status": "queued", "updated_at": _now_iso()},
            )
            logger.warning("Requeued stale job %s (%s)", job["id"], job["kind"])
        else:
            await _fail_job(svc, job["id"], "max attempts exceeded (stale)")
            await _fail_file_for_job(svc, job)
            logger.error("Failed stale job %s after max attempts", job["id"])
    return len(stale)


async def _fail_job(svc: ServiceClient, job_id: str, error: str) -> None:
    await svc.update(
        "jobs",
        {"id": f"eq.{job_id}"},
        {"status": "failed", "error": error[:1000], "updated_at": _now_iso()},
    )


async def _fail_file_for_job(svc: ServiceClient, job: dict[str, Any]) -> None:
    """Drive the file to a terminal status when a job permanently fails."""
    file_id = job.get("target_id")
    if not file_id:
        return
    if job.get("kind") == "embedding_split":
        await svc.update(
            "files",
            {"id": f"eq.{file_id}"},
            {"status": "failed", "error": "split failed"},
        )
    else:  # embedding_batch: fail this batch's still-pending chunks, then finalize
        rng = job.get("batch_range") or {}
        if "from_seq" in rng and "to_seq" in rng:
            await svc.update(
                "file_chunks",
                {
                    "file_id": f"eq.{file_id}",
                    "and": f"(seq.gte.{int(rng['from_seq'])},seq.lt.{int(rng['to_seq'])})",
                    "status": "eq.pending",
                },
                {"status": "failed"},
            )
        await _finalize_file(svc, file_id)


# ---------------------------------------------------------------------------
# embedding_split
# ---------------------------------------------------------------------------
async def _handle_split(svc: ServiceClient, job: dict[str, Any]) -> None:
    file_id = job["target_id"]
    files = await svc.select(
        "files",
        {"id": f"eq.{file_id}", "select": "id,owner_id,storage_path,mime,space_ref",
         "limit": "1"},
    )
    if not files:
        await _fail_job(svc, job["id"], "file row missing")
        return
    f = files[0]

    # D65 integrity guard: the embedding column is a fixed vector(768). If the
    # admin set embedding_dimension to anything else, embedding now would write
    # vectors that don't match the column/index — fail the file as "re-embed
    # required" WITHOUT inserting anything, rather than corrupt the DB. Fixing
    # the dimension back to 768 + retry recovers it.
    overlay = await app_settings.get_overlay()
    embed_dim = app_settings.as_int(
        overlay, "embedding_dimension", settings.embedding_dimension, 1, 10000
    )
    if embed_dim != embedding.DB_VECTOR_DIM:
        logger.warning(
            "embedding_dimension=%s != %s (vector column); failing split "
            "file=%s (dimension mismatch; re-embed required)",
            embed_dim,
            embedding.DB_VECTOR_DIM,
            file_id,
        )
        await svc.update(
            "files",
            {"id": f"eq.{file_id}"},
            {"status": "failed", "error": "dimension mismatch; re-embed required"},
        )
        await _fail_job(svc, job["id"], "dimension mismatch; re-embed required")
        return

    # Idempotency (crash recovery): if batch jobs already exist for this file the
    # split already fanned out — just mark this (re-queued) split done. Otherwise
    # clear any partial chunks from a crashed prior split and start fresh (no
    # chunk is embedded before batch jobs exist, so deleting is safe).
    existing_batches = await svc.count(
        "jobs", {"target_id": f"eq.{file_id}", "kind": "eq.embedding_batch"}
    )
    if existing_batches > 0:
        await svc.update(
            "jobs", {"id": f"eq.{job['id']}"},
            {"status": "done", "updated_at": _now_iso()},
        )
        logger.info("split file=%s already fanned out; marking done", file_id)
        return
    await svc.delete("file_chunks", {"file_id": f"eq.{file_id}"})

    await svc.update("files", {"id": f"eq.{file_id}"}, {"status": "splitting"})

    data = await svc.storage_download(settings.storage_bucket, f["storage_path"])
    text = await _extract_text(data, f.get("mime"), f["storage_path"])
    # D65 new-only: chunk size/overlap come from the admin overlay and apply to
    # THIS (new) job; existing chunks are untouched until re-uploaded.
    chunk_size = app_settings.as_int(
        overlay, "chunk_size_chars", settings.chunk_size_chars, 400, 4000
    )
    chunk_overlap = app_settings.as_int(
        overlay, "chunk_overlap_chars", settings.chunk_overlap_chars, 0, 500
    )
    chunks = embedding.chunk_text(text, chunk_size, chunk_overlap)

    if not chunks:
        await svc.update(
            "files",
            {"id": f"eq.{file_id}"},
            {"status": "failed", "error": "no extractable text"},
        )
        await svc.update(
            "jobs", {"id": f"eq.{job['id']}"},
            {"status": "done", "updated_at": _now_iso()},
        )
        return

    # Insert chunk rows (pending) in manageable batches.
    rows = [
        {"file_id": file_id, "seq": i, "chunk_text": c, "status": "pending"}
        for i, c in enumerate(chunks)
    ]
    for i in range(0, len(rows), 500):
        await svc.insert("file_chunks", rows[i : i + 500], returning=False)

    await svc.update(
        "files",
        {"id": f"eq.{file_id}"},
        {"status": "embedding", "chunk_total": len(chunks), "chunk_done": 0},
    )

    # Fan out embedding_batch child jobs over seq ranges.
    bsize = max(1, settings.embedding_batch_size)
    child_jobs = [
        {
            "owner_id": f.get("owner_id"),
            "kind": "embedding_batch",
            "target_id": file_id,
            "parent_job_id": job["id"],
            "batch_range": {"from_seq": start, "to_seq": min(start + bsize, len(chunks))},
            "status": "queued",
            "space_ref": f.get("space_ref"),
        }
        for start in range(0, len(chunks), bsize)
    ]
    await svc.insert("jobs", child_jobs, returning=False)
    await svc.update(
        "jobs", {"id": f"eq.{job['id']}"},
        {"status": "done", "updated_at": _now_iso()},
    )
    logger.info("split file=%s -> %d chunks, %d batches", file_id, len(chunks),
                len(child_jobs))


# ---------------------------------------------------------------------------
# embedding_batch
# ---------------------------------------------------------------------------
async def _handle_batch(svc: ServiceClient, job: dict[str, Any]) -> None:
    file_id = job["target_id"]
    rng = job.get("batch_range") or {}
    from_seq = int(rng.get("from_seq", 0))
    to_seq = int(rng.get("to_seq", 0))

    chunks = await svc.select(
        "file_chunks",
        {
            "file_id": f"eq.{file_id}",
            # seq in [from_seq, to_seq)
            "and": f"(seq.gte.{from_seq},seq.lt.{to_seq})",
            "status": "eq.pending",
            "select": "id,seq,chunk_text",
            "order": "seq.asc",
        },
    )
    if chunks:
        # D65 integrity guard (also here: config may change between split and
        # batch). Mismatched dimension -> fail this job WITHOUT writing vectors;
        # chunks stay pending so a retry after fixing the dimension recovers.
        overlay = await app_settings.get_overlay()
        embed_dim = app_settings.as_int(
            overlay, "embedding_dimension", settings.embedding_dimension, 1, 10000
        )
        embed_model = app_settings.as_str(
            overlay, "embedding_model", settings.gemini_embedding_model
        )
        if embed_dim != embedding.DB_VECTOR_DIM:
            logger.warning(
                "embedding_dimension=%s != %s (vector column); failing batch "
                "file=%s (dimension mismatch; re-embed required)",
                embed_dim,
                embedding.DB_VECTOR_DIM,
                file_id,
            )
            await _fail_job(svc, job["id"], "dimension mismatch; re-embed required")
            return
        try:
            vectors = await embedding.embed_texts(
                [c["chunk_text"] for c in chunks],
                task_type="RETRIEVAL_DOCUMENT",
                model=embed_model,
                dimension=embed_dim,
            )
        except Exception as exc:  # noqa: BLE001 - mark chunks failed, not crash
            logger.exception("Batch embedding failed file=%s", file_id)
            for c in chunks:
                await svc.update(
                    "file_chunks", {"id": f"eq.{c['id']}"}, {"status": "failed"}
                )
            await _finalize_file(svc, file_id)
            await _fail_job(svc, job["id"], f"embed error: {exc}")
            return

        # Embedding count MUST match the chunk count; a short/over response would
        # otherwise silently leave chunks pending (file stuck). Fail the whole
        # batch on mismatch so the stale/retry path can reprocess it.
        if len(vectors) != len(chunks):
            logger.error(
                "Embedding count mismatch file=%s: %d vectors for %d chunks",
                file_id, len(vectors), len(chunks),
            )
            for c in chunks:
                await svc.update(
                    "file_chunks", {"id": f"eq.{c['id']}"}, {"status": "failed"}
                )
            await _finalize_file(svc, file_id)
            await _fail_job(svc, job["id"], "embedding count mismatch")
            return

        sem = asyncio.Semaphore(8)

        async def _store(chunk: dict[str, Any], vec: list[float]) -> None:
            async with sem:
                await svc.update(
                    "file_chunks",
                    {"id": f"eq.{chunk['id']}"},
                    {"embedding": _vector_literal(vec), "status": "embedded"},
                )

        await asyncio.gather(
            *(_store(c, v) for c, v in zip(chunks, vectors, strict=True))
        )

    await _finalize_file(svc, file_id)
    await svc.update(
        "jobs", {"id": f"eq.{job['id']}"},
        {"status": "done", "updated_at": _now_iso()},
    )


async def _finalize_file(svc: ServiceClient, file_id: str) -> None:
    """Recompute progress; mark indexed/partial when no pending chunks remain.

    When the file first transitions to 'indexed', kick off file tagging once
    (best-effort). A conditional update (status != 'indexed') ensures only the
    batch that performs the transition triggers tagging.
    """
    embedded = await svc.count(
        "file_chunks", {"file_id": f"eq.{file_id}", "status": "eq.embedded"}
    )
    failed = await svc.count(
        "file_chunks", {"file_id": f"eq.{file_id}", "status": "eq.failed"}
    )
    pending = await svc.count(
        "file_chunks", {"file_id": f"eq.{file_id}", "status": "eq.pending"}
    )

    if pending != 0:
        await svc.update("files", {"id": f"eq.{file_id}"}, {"chunk_done": embedded})
        return
    if failed > 0:
        await svc.update(
            "files", {"id": f"eq.{file_id}"},
            {"chunk_done": embedded, "status": "partial"},
        )
        return
    # All chunks embedded -> indexed. Conditional so tagging fires exactly once.
    rows = await svc.update(
        "files",
        {"id": f"eq.{file_id}", "status": "neq.indexed"},
        {"chunk_done": embedded, "status": "indexed"},
    )
    if rows:
        await _tag_file(svc, file_id)


async def _tag_file(svc: ServiceClient, file_id: str) -> None:
    """Extract up to file_tag_max concepts from the file and link them (50 cap).

    Best-effort: tagging failure never reverts the 'indexed' status.
    """
    try:
        chunks = await svc.select(
            "file_chunks",
            {
                "file_id": f"eq.{file_id}",
                "status": "eq.embedded",
                "select": "chunk_text",
                "order": "seq.asc",
                "limit": "40",
            },
        )
        text = "\n\n".join(c.get("chunk_text") or "" for c in chunks)
        names = await tagging.extract_file_concepts(text)
        if names:
            await svc.rpc(
                "upsert_file_tags", {"p_file_id": file_id, "p_names": names}
            )
            logger.info("Tagged file=%s with %d concepts", file_id, len(names))
    except Exception:  # noqa: BLE001 - tagging must not break indexing
        logger.exception("File tagging failed for %s", file_id)


async def requeue_file(svc: ServiceClient, file_id: str) -> str:
    """Re-process a failed/partial/stuck file (idempotent). service_role.

    - no chunks  -> reset and enqueue a fresh embedding_split job;
    - has chunks -> reset failed chunks to pending and fan out fresh
      embedding_batch jobs over the file's seq range (the batch handler skips
      already-embedded chunks). Returns the action taken.
    """
    rows = await svc.select(
        "files",
        {"id": f"eq.{file_id}", "select": "id,owner_id,space_ref", "limit": "1"},
    )
    if not rows:
        return "missing"
    f = rows[0]

    total = await svc.count("file_chunks", {"file_id": f"eq.{file_id}"})
    if total == 0:
        await svc.update(
            "files", {"id": f"eq.{file_id}"},
            {"status": "uploaded", "error": None, "chunk_done": 0, "chunk_total": 0},
        )
        await svc.insert(
            "jobs",
            {
                "owner_id": f.get("owner_id"),
                "kind": "embedding_split",
                "target_id": file_id,
                "status": "queued",
                "space_ref": f.get("space_ref"),
            },
            returning=False,
        )
        return "split_requeued"

    # Reset failed chunks back to pending.
    await svc.update(
        "file_chunks",
        {"file_id": f"eq.{file_id}", "status": "eq.failed"},
        {"status": "pending"},
    )
    pending = await svc.count(
        "file_chunks", {"file_id": f"eq.{file_id}", "status": "eq.pending"}
    )
    if pending == 0:
        await _finalize_file(svc, file_id)
        return "already_complete"

    await svc.update(
        "files", {"id": f"eq.{file_id}"}, {"status": "embedding", "error": None}
    )
    bsize = max(1, settings.embedding_batch_size)
    child_jobs = [
        {
            "owner_id": f.get("owner_id"),
            "kind": "embedding_batch",
            "target_id": file_id,
            "batch_range": {"from_seq": start, "to_seq": min(start + bsize, total)},
            "status": "queued",
            "space_ref": f.get("space_ref"),
        }
        for start in range(0, total, bsize)
    ]
    await svc.insert("jobs", child_jobs, returning=False)
    return "batches_requeued"


# ---------------------------------------------------------------------------
# Poll loop
# ---------------------------------------------------------------------------
async def _process(svc: ServiceClient, job: dict[str, Any]) -> None:
    try:
        if job["kind"] == "embedding_split":
            await _handle_split(svc, job)
        elif job["kind"] == "embedding_batch":
            await _handle_batch(svc, job)
        else:
            await _fail_job(svc, job["id"], f"unknown kind {job['kind']}")
    except Exception as exc:  # noqa: BLE001
        logger.exception("Job %s failed", job.get("id"))
        try:
            await _fail_job(svc, job["id"], str(exc))
        except Exception:  # noqa: BLE001
            logger.exception("Could not mark job failed")


async def poll_once() -> int:
    """Claim and process one batch of queued jobs. Returns #processed."""
    svc = get_service_client()
    if svc is None:
        return 0
    if _poll_lock.locked():
        return 0
    async with _poll_lock:
        # Recover orphaned 'running' jobs from a crashed worker before claiming.
        try:
            await _recover_stale_jobs(svc)
        except Exception:  # noqa: BLE001 - recovery must not break the poll
            logger.exception("Stale job recovery failed")
        claimed = await _claim_jobs(svc, settings.embedding_worker_concurrency)
        if not claimed:
            return 0
        await asyncio.gather(*(_process(svc, j) for j in claimed))
        return len(claimed)


def start(_app: object | None = None) -> None:
    """Start the polling scheduler if a service-role client is available."""
    global _scheduler
    if get_service_client() is None:
        logger.warning("Embedding worker NOT started (no service-role key).")
        return
    if _scheduler is not None:
        return
    _scheduler = AsyncIOScheduler()
    _scheduler.add_job(
        poll_once,
        "interval",
        seconds=settings.embedding_worker_poll_seconds,
        max_instances=1,
        coalesce=True,
        id="embedding_poll",
    )
    _scheduler.start()
    logger.info(
        "Embedding worker started (poll=%ss, concurrency=%s).",
        settings.embedding_worker_poll_seconds,
        settings.embedding_worker_concurrency,
    )


def stop() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
