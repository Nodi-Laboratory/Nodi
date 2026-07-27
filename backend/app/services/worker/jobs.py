"""잡 수명주기 — 클레임 · 스테일 복구 · 실패 처리 · 파일 마감.

잡 상태 머신(queued → running → done/failed)과 파일 상태(processing →
indexed/partial/failed)를 다루는 곳. 잡을 소비하는 핸들러(split·batch·figures)는
여기를 한정 호출한다.
"""

from __future__ import annotations

import logging
from typing import Any

from ...config import get_settings
from ...db.client import ServiceClient
from . import common

logger = logging.getLogger("nodi.worker.jobs")
settings = get_settings()

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
                "updated_at": common._now_iso(),
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
    # D104: 컷오프를 파이썬이 아니라 **DB에서** 계산한다(`before.<초>`).
    # asyncpg가 timestamptz 파라미터에 문자열을 받지 않기도 하고, 앱 시계와 DB
    # 시계가 어긋나면 스테일 판정 자체가 틀리기 때문이다.
    stale = await svc.select(
        "jobs",
        {
            "status": "eq.running",
            "updated_at": f"before.{settings.embedding_stale_seconds}",
            "select": "id,kind,target_id,attempts,batch_range",
            "limit": "50",
        },
    )
    for job in stale:
        if (job.get("attempts") or 0) < settings.embedding_max_attempts:
            await svc.update(
                "jobs",
                {"id": f"eq.{job['id']}", "status": "eq.running"},
                {"status": "queued", "updated_at": common._now_iso()},
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
        {"status": "failed", "error": error[:1000], "updated_at": common._now_iso()},
    )


async def _fail_file_for_job(
    svc: ServiceClient, job: dict[str, Any], error: str = "split failed"
) -> None:
    """Drive the file to a terminal status when a job permanently fails."""
    file_id = job.get("target_id")
    if not file_id:
        return
    kind = job.get("kind")
    if kind == "embedding_split":
        # D76: 실패 사유를 파일 행에 남긴다(교사 자료실 실패 배지의 안내 문구).
        await svc.update(
            "files",
            {"id": f"eq.{file_id}"},
            {"status": "failed", "error": error[:500]},
        )
    elif kind == "figure_batch":
        # D88: figure_batch 영구 실패는 파일 status를 바꾸지 않는다(figure는
        # files.status와 무관). 범위 내 pending figure 행만 failed로 두고,
        # _finalize_file은 호출하지 않는다(텍스트 인덱싱 진행과 독립).
        rng = job.get("batch_range") or {}
        if "from_seq" in rng and "to_seq" in rng:
            await svc.update(
                "textbook_figures",
                {
                    "file_id": f"eq.{file_id}",
                    "and": f"(seq.gte.{int(rng['from_seq'])},seq.lt.{int(rng['to_seq'])})",
                    "status": "eq.pending",
                },
                {"status": "failed"},
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


async def _finalize_file(svc: ServiceClient, file_id: str) -> None:
    """Recompute progress; mark indexed/partial when no pending chunks remain."""
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
    # 모든 청크 임베딩 완료 -> indexed. 조건부 업데이트(status != 'indexed')로
    # 동시 배치가 파일을 정확히 1회 종결하게 한다(D80: 파일 태깅 훅 제거).
    await svc.update(
        "files",
        {"id": f"eq.{file_id}", "status": "neq.indexed"},
        {"chunk_done": embedded, "status": "indexed"},
    )
