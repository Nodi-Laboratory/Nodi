"""embedding_batch 잡 — 청크 임베딩 → Qdrant 업서트 → 진행률 갱신.

Upstage embedding-passage(4096d)로 임베딩하고 벡터는 Qdrant에만 넣는다.
Postgres에는 상태만 기록한다(본문은 file_chunks에 이미 있다).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ...db.client import ServiceClient
from .. import embedding
from . import common, jobs

logger = logging.getLogger("nodi.worker.batch")

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
        # 페이로드 owner_id는 파일 행에서 파생(스코핑 필터 참고용 —
        # Qdrant 페이로드는 신뢰 경계가 아니다).
        files = await svc.select(
            "files", {"id": f"eq.{file_id}", "select": "id,owner_id", "limit": "1"}
        )
        if not files:
            await jobs._fail_job(svc, job["id"], "file row missing")
            return
        owner_id = files[0].get("owner_id")

        try:
            vectors = await embedding.embed_texts(
                [c["chunk_text"] for c in chunks],
                task_type="RETRIEVAL_DOCUMENT",
            )
        except Exception as exc:  # noqa: BLE001 - mark chunks failed, not crash
            logger.exception("Batch embedding failed file=%s", file_id)
            for c in chunks:
                await svc.update(
                    "file_chunks", {"id": f"eq.{c['id']}"}, {"status": "failed"}
                )
            await jobs._finalize_file(svc, file_id)
            await jobs._fail_job(svc, job["id"], f"embed error: {exc}")
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
            await jobs._finalize_file(svc, file_id)
            await jobs._fail_job(svc, job["id"], "embedding count mismatch")
            return

        # 벡터는 Qdrant에만 업서트 — 포인트 id=청크 uuid(재시도 시 덮어쓰기),
        # 페이로드는 본문 없는 최소 셋 {chunk_id, file_id, owner_id}.
        points = [
            {
                "id": c["id"],
                "vector": v,
                "payload": {
                    "chunk_id": c["id"],
                    "file_id": str(file_id),
                    "owner_id": str(owner_id) if owner_id else None,
                },
            }
            for c, v in zip(chunks, vectors, strict=True)
        ]
        try:
            await common._qdrant_upsert(points)
        except Exception as exc:  # noqa: BLE001 - Qdrant 장애도 embed 실패와 동일 처리
            logger.exception("Qdrant upsert failed file=%s", file_id)
            for c in chunks:
                await svc.update(
                    "file_chunks", {"id": f"eq.{c['id']}"}, {"status": "failed"}
                )
            await jobs._finalize_file(svc, file_id)
            await jobs._fail_job(svc, job["id"], f"qdrant error: {exc}")
            return

        # Supabase엔 상태만 기록(embedding 컬럼 미사용 — migration 0028).
        sem = asyncio.Semaphore(8)

        async def _mark(chunk: dict[str, Any]) -> None:
            async with sem:
                await svc.update(
                    "file_chunks",
                    {"id": f"eq.{chunk['id']}"},
                    {"status": "embedded"},
                )

        await asyncio.gather(*(_mark(c) for c in chunks))

    await jobs._finalize_file(svc, file_id)
    await svc.update(
        "jobs", {"id": f"eq.{job['id']}"},
        {"status": "done", "updated_at": common._now_iso()},
    )
