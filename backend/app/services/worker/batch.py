"""embedding_batch 잡 — 청크 임베딩 → Qdrant 업서트 → 진행률 갱신.

Upstage embedding-passage(upstage.EMBED_DIM)로 임베딩하고 벡터는 Qdrant에만 넣는다.
Postgres에는 상태만 기록한다(본문은 file_chunks에 이미 있다).

D195: 잡 하나가 맡은 청크를 **요청 크기(Upstage 상한 100)로 쪼개 동시에** 보낸다.
예전에는 잡 하나 = 요청 하나였고, 파일을 빨리 끝내려면 잡을 잘게 나누는 수밖에
없었는데 잡은 폴 주기(5초)와 워커 동시성(3)에 묶여 있다 — 청크가 늘수록 큐에서
기다리는 시간이 선형으로 늘었다. 이제 **파일을 쪼개는 일과 병렬로 보내는 일이
분리된다**: 잡은 굵게(300), 요청은 잘게(100) 동시에.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from ...config import get_settings
from ...db.client import ServiceClient
from .. import app_settings, embedding, upstage
from . import common, jobs

logger = logging.getLogger("nodi.worker.batch")
settings = get_settings()

# 슬라이스가 도는 동안 잡 하트비트를 찍는 간격(초). 스테일 기준(120초)의 1/4 —
# 재시도 백오프(429/5xx)로 요청 하나가 길어져도 스테일 복구가 **돌고 있는 잡을
# 재클레임**해 같은 청크를 두 번 임베딩하는 일을 막는다(D133 동형).
_HEARTBEAT_SECONDS = 30.0


# ---------------------------------------------------------------------------
# embedding_batch
# ---------------------------------------------------------------------------
async def _mark_chunks(
    svc: ServiceClient, file_id: str, part: list[dict[str, Any]], status: str
) -> None:
    """슬라이스의 청크 상태를 **한 번의 update**로 옮긴다.

    예전에는 청크마다 update를 날렸다(세마포어 8) — 300청크면 왕복 300번이다.
    슬라이스는 seq 오름차순 연속 구간이고 pending 필터가 걸려 있으므로, 구간
    갱신이 남의 청크를 건드릴 수 없다(잡끼리 seq 범위가 겹치지 않는다).
    """
    if not part:
        return
    lo = int(part[0]["seq"])
    hi = int(part[-1]["seq"]) + 1
    await svc.update(
        "file_chunks",
        {
            "file_id": f"eq.{file_id}",
            "and": f"(seq.gte.{lo},seq.lt.{hi})",
            "status": "eq.pending",
        },
        {"status": status},
    )


async def _heartbeat(svc: ServiceClient, job_id: str) -> None:
    """슬라이스가 도는 동안 jobs.updated_at을 전진시킨다(D133)."""
    while True:
        await asyncio.sleep(_HEARTBEAT_SECONDS)
        await common.touch_job(svc, job_id)


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
    failures: list[str] = []
    failed_chunks = 0
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

        overlay = await app_settings.get_overlay()
        concurrency = app_settings.as_int(
            overlay,
            "embedding_request_concurrency",
            settings.embedding_request_concurrency,
            1,
            16,
        )
        size = upstage.EMBED_MAX_BATCH
        slices = [chunks[i : i + size] for i in range(0, len(chunks), size)]
        sem = asyncio.Semaphore(concurrency)

        async def _run(part: list[dict[str, Any]]) -> str | None:
            """슬라이스 하나: 임베딩 → Qdrant → 상태. 실패는 **이 슬라이스에서 끝난다**.

            예전에는 요청 하나가 실패하면 잡의 청크 전부를 failed로 떨궜다.
            잡이 굵어진 지금 그 규칙을 그대로 두면 429 한 번에 300청크가 날아간다 —
            이미 성공한 요청의 결과까지 버리는 것은 재시도 비용을 그만큼 더 무는 일이다.
            """
            async with sem:
                try:
                    vectors = await embedding.embed_texts(
                        [c["chunk_text"] for c in part],
                        task_type="RETRIEVAL_DOCUMENT",
                        concurrency=concurrency,
                    )
                    # 응답 개수가 어긋나면 벡터가 다른 청크에 붙는다 — 조용히
                    # pending으로 남기지 말고 이 슬라이스를 실패로 끊는다.
                    if len(vectors) != len(part):
                        raise RuntimeError(
                            f"embedding count mismatch: {len(vectors)} vectors "
                            f"for {len(part)} chunks"
                        )
                    # 벡터는 Qdrant에만 업서트 — 포인트 id=청크 uuid(재시도 시
                    # 덮어쓰기), 페이로드는 본문 없는 최소 셋.
                    await common._qdrant_upsert(
                        [
                            {
                                "id": c["id"],
                                "vector": v,
                                "payload": {
                                    "chunk_id": c["id"],
                                    "file_id": str(file_id),
                                    "owner_id": str(owner_id) if owner_id else None,
                                },
                            }
                            for c, v in zip(part, vectors, strict=True)
                        ]
                    )
                except Exception as exc:  # noqa: BLE001 - 슬라이스 격리
                    logger.exception(
                        "슬라이스 실패 file=%s seq=[%s,%s]",
                        file_id, part[0]["seq"], part[-1]["seq"],
                    )
                    await _mark_chunks(svc, file_id, part, "failed")
                    return f"seq {part[0]['seq']}~{part[-1]['seq']}: {exc}"
                # Postgres엔 상태만 기록(embedding 컬럼 미사용 — migration 0028).
                await _mark_chunks(svc, file_id, part, "embedded")
                return None

        beat = asyncio.create_task(_heartbeat(svc, job["id"]))
        try:
            results = await asyncio.gather(*(_run(p) for p in slices))
        finally:
            beat.cancel()
            # 취소를 흘려보내지 않으면 "Task was destroyed but it is pending"이
            # 운영 로그에 남는다 — 하트비트가 로그를 어지럽힐 이유가 없다.
            with contextlib.suppress(asyncio.CancelledError):
                await beat
        failures = [r for r in results if r]
        failed_chunks = sum(len(p) for p, r in zip(slices, results, strict=True) if r)
        logger.info(
            "배치 완료 file=%s 청크=%d 요청=%d(동시 %d) 실패요청=%d",
            file_id, len(chunks), len(slices), concurrency, len(failures),
        )

    await jobs._finalize_file(svc, file_id)
    if failures:
        # 일부라도 실패하면 잡은 failed다 — 성공한 슬라이스는 embedded로 남고,
        # 실패분만 retry_file이 pending으로 되돌린다(부분 진행 보존).
        await jobs._fail_job(
            svc,
            job["id"],
            f"{failed_chunks}/{len(chunks)} 청크 실패 — {failures[0]}",
        )
        return
    await svc.update(
        "jobs", {"id": f"eq.{job['id']}"},
        {"status": "done", "updated_at": common._now_iso()},
    )
