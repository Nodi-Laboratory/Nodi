"""워커 구동 — 폴링 루프 · 스케줄러 · 잡 디스패치 · 재처리 진입점.

apscheduler가 poll_once를 주기 호출하고, 한 번의 폴에서
`embedding_worker_concurrency`개까지 잡을 클레임해 동시에 처리한다.
클레임은 queued→running 조건부 갱신이라 한 잡이 한 번만 처리된다.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from ...config import get_settings
from ...db.client import ServiceClient, get_service_client
from . import batch, common, figures, jobs, split

logger = logging.getLogger("nodi.worker.runner")
settings = get_settings()

_scheduler: AsyncIOScheduler | None = None
_poll_lock = asyncio.Lock()


async def requeue_file(svc: ServiceClient, file_id: str) -> str:
    """Re-process a failed/partial/stuck file (idempotent). service_role.

    - no chunks  -> reset and enqueue a fresh embedding_split job;
    - has chunks -> reset failed chunks to pending and fan out fresh
      embedding_batch jobs over the file's seq range (the batch handler skips
      already-embedded chunks). Returns the action taken.

    D86: textbook은 여기에 더해 실패 figure 행도 pending으로 리셋·재팬아웃하고,
    그 사실을 액션 문자열에 합류시킨다(관측성). 청크가 아예 없어 fresh split을
    거는 경로는 그 split이 figure까지 다시 팬아웃하므로 별도 처리하지 않는다.
    """
    rows = await svc.select(
        "files",
        {"id": f"eq.{file_id}", "select": "id,owner_id,space_ref,kind", "limit": "1"},
    )
    if not rows:
        return "missing"
    f = rows[0]
    is_textbook = f.get("kind") == "textbook"

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
        await jobs._finalize_file(svc, file_id)
        action = "already_complete"
    else:
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
        action = "batches_requeued"

    if is_textbook:
        figure_action = await figures._requeue_figures(svc, f, file_id)
        if figure_action:
            action = f"{action}+{figure_action}"
    return action


# ---------------------------------------------------------------------------
# Poll loop
# ---------------------------------------------------------------------------
async def _process(svc: ServiceClient, job: dict[str, Any]) -> None:
    try:
        if job["kind"] == "embedding_split":
            await split._handle_split(svc, job)
        elif job["kind"] == "embedding_batch":
            await batch._handle_batch(svc, job)
        elif job["kind"] == "figure_batch":
            await figures._handle_figure_batch(svc, job)
        else:
            await jobs._fail_job(svc, job["id"], f"unknown kind {job['kind']}")
    except Exception as exc:  # noqa: BLE001
        logger.exception("Job %s failed", job.get("id"))
        try:
            # D76: 즉시 예외도 스테일 복구와 동일 정책 — attempts가 남으면
            # 재큐(다음 폴에서 재시도), 소진 시 잡 failed + 파일 터미널 전환.
            # 기존에는 잡만 failed 처리해 files.status가 'splitting'에 영구
            # 고착됐다(G6 — 실패 배지가 안 떠 재시도 동선의 전제가 붕괴).
            if (job.get("attempts") or 0) < settings.embedding_max_attempts:
                await svc.update(
                    "jobs",
                    {"id": f"eq.{job['id']}"},
                    {"status": "queued", "updated_at": common._now_iso()},
                )
            else:
                await jobs._fail_job(svc, job["id"], str(exc))
                await jobs._fail_file_for_job(svc, job, str(exc) or "split failed")
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
            await jobs._recover_stale_jobs(svc)
        except Exception:  # noqa: BLE001 - recovery must not break the poll
            logger.exception("Stale job recovery failed")
        claimed = await jobs._claim_jobs(svc, settings.embedding_worker_concurrency)
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
