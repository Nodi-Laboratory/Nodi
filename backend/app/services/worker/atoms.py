"""atom_batch 잡 — 청크당 예상 질문 생성 · 임베딩 · Qdrant 적재 (D129, PIKE-RAG).

청크 하나에서 solar가 "이 청크로 답할 수 있는 핵심 질문 n개"를 뽑고(atomize),
그 질문을 embedding-passage로 임베딩해 chunk_atoms 컬렉션에 넣는다. 학생 질의
(embedding-query)와 질문↔질문 매칭으로 검색 재현율을 높이는 게 목적이다.

원자화는 텍스트 인덱싱과 격리된다(files.status 불가침, D88 동형) — 원자 실패는
파일 상태를 바꾸지 않고 _finalize_file도 호출하지 않는다. figures.py의
_handle_figure_batch·_requeue_figures를 구조·주석 스타일까지 본떴다.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ...config import get_settings
from ...db.client import ServiceClient
from .. import (
    app_settings,
    atomize,
    embedding,
    qdrant_store,
    solar,
)
from . import common, jobs

logger = logging.getLogger("nodi.worker.atoms")
settings = get_settings()

# 회로차단 임계치 — solar가 연속 이만큼 실패하면 잔여 청크 생성을 생략하고
# 배치를 실패 처리한다(figure_judge.CIRCUIT_BREAK_THRESHOLD와 동형). 죽은
# 엔드포인트에서 청크마다 재시도가 누적돼 잡이 길어지는 사고를 막는다.
CIRCUIT_BREAK_THRESHOLD = 5


# ---------------------------------------------------------------------------
# atom_batch (D129 — chunk_atoms 질문 생성·임베딩·Qdrant 적재)
# ---------------------------------------------------------------------------
async def _handle_atom_batch(svc: ServiceClient, job: dict[str, Any]) -> None:
    """batch_range의 청크에서 예상 질문을 생성→임베딩→Qdrant(chunk_atoms) 적재.

    핵심 동작(figures.py를 본뜸):
    1. batch_range의 file_chunks(seq 범위, 본문만) 조회 — status 무관.
    2. 행 단위 멱등: **embedded** 원자가 있는 청크만 스킵한다(정상 재시도 중복
       insert 방지). 비-embedded(pending/failed) 잔여 행은 재큐·복구 대상이므로
       삭제 후 재생성한다(+구 Qdrant 포인트 정리) — 존재 기반 스킵이 리셋 행을
       삼켜 pending을 영구 정체시키던 버그 수정(task6-fix2).
    3. 킬스위치 재확인(atom_rag_enabled) — 팬아웃 후 off로 바꿨으면 조용히 done.
    4. 청크당 solar.complete로 질문 n개 생성(동시성 세마포어 + 4청크마다 하트비트).
       개별 실패는 그 청크만 건너뛰고, 연속 CIRCUIT_BREAK_THRESHOLD회 실패면 회로차단·배치 실패.
    5. chunk_atoms insert(pending) → embedding-passage → Qdrant 업서트 → 행 embedded.
    6. 임베딩·Qdrant 실패 = 행 failed + 잡 failed(attempts 재시도 상속).
       files.status·_finalize_file은 절대 건드리지 않는다(D88 동형).
    """
    file_id = job["target_id"]
    rng = job.get("batch_range") or {}
    from_seq = int(rng.get("from_seq", 0))
    to_seq = int(rng.get("to_seq", 0))

    # 1. 범위 내 청크 본문(status 무관 — 원자화는 임베딩 상태와 독립).
    chunks = await svc.select(
        "file_chunks",
        {
            "file_id": f"eq.{file_id}",
            "and": f"(seq.gte.{from_seq},seq.lt.{to_seq})",
            "select": "id,seq,chunk_text",
            "order": "seq.asc",
        },
    )
    if not chunks:
        await _mark_job_done(svc, job["id"])
        return

    # 3. 킬스위치 재확인 — 팬아웃 후 off로 바뀌었으면 solar 없이 마감.
    overlay = await app_settings.get_overlay()
    if not app_settings.as_bool(
        overlay, "atom_rag_enabled", settings.atom_rag_enabled
    ):
        logger.info("atom kill switch off — 원자 생성 생략 file=%s", file_id)
        await _mark_job_done(svc, job["id"])
        return

    # 2. 행 단위 멱등 — 이미 **embedded** 원자가 있는 청크만 "완료"로 보고 스킵한다.
    #    (task6-fix2) 존재 기반 멱등(status 무관)은 _requeue_atoms의 failed→pending
    #    리셋·재큐, requeue_file 복구, 크래시 잔여 pending을 모두 스킵해 pending을
    #    영구 정체시켰다. 그래서 비-embedded(pending/failed) 잔여 행은 완료로 치지
    #    않고, 재생성 대상 청크의 잔여 행은 삭제 후 재생성한다. 삭제 행의 Qdrant
    #    포인트(포인트 id=원자 uuid)도 함께 지워 고아를 남기지 않는다. embedded 행은
    #    건드리지 않으므로 정상 재시도 시 중복 생성은 여전히 없다(행 단위 멱등 유지).
    chunk_ids = [c["id"] for c in chunks]
    existing = await svc.select(
        "chunk_atoms",
        {
            "file_id": f"eq.{file_id}",
            "chunk_id": "in.(" + ",".join(str(cid) for cid in chunk_ids) + ")",
            "select": "id,chunk_id,status",
        },
    )
    embedded_chunk_ids = {
        str(r["chunk_id"]) for r in existing if r.get("status") == "embedded"
    }
    todo = [c for c in chunks if str(c["id"]) not in embedded_chunk_ids]
    if not todo:
        await _mark_job_done(svc, job["id"])
        return
    # 재생성 대상 청크의 비-embedded 잔여 행 삭제(+Qdrant 포인트 정리) — 이게 없으면
    # 재큐로 리셋된 pending 행이 그대로 남아 이 배치가 다시 스킵한다.
    stale_atom_ids = [
        str(r["id"])
        for r in existing
        if r.get("status") != "embedded"
        and str(r["chunk_id"]) not in embedded_chunk_ids
    ]
    if stale_atom_ids:
        await svc.delete(
            "chunk_atoms",
            {"id": "in.(" + ",".join(stale_atom_ids) + ")"},
        )
        await common._qdrant_delete_points(
            stale_atom_ids, collection=qdrant_store.COL_CHUNK_ATOMS
        )

    files = await svc.select(
        "files", {"id": f"eq.{file_id}", "select": "id,owner_id", "limit": "1"}
    )
    if not files:
        await jobs._fail_job(svc, job["id"], "file row missing")
        return
    owner_id = files[0].get("owner_id")

    # 4. 청크당 질문 생성 — asyncio.Semaphore로 동시성 제한, 4청크마다 하트비트.
    n = app_settings.as_int(
        overlay, "atom_questions_per_chunk", settings.atom_questions_per_chunk, 1, 8
    )
    concurrency = app_settings.as_int(
        overlay, "atom_gen_concurrency", settings.atom_gen_concurrency, 1, 16
    )
    sem = asyncio.Semaphore(max(1, concurrency))
    # 회로차단 상태 — 세마포어로 직렬화된 임계 구간에서만 갱신하므로 락 불필요
    # (asyncio 단일 스레드: await 사이 정수 증감은 원자적).
    state = {"consecutive": 0, "broken": False}
    progress = {"count": 0}
    questions_by_chunk: dict[str, list[str]] = {}

    async def _gen(chunk: dict[str, Any]) -> None:
        async with sem:
            if state["broken"]:
                return  # 회로 개방 — 잔여 청크 생성 생략
            try:
                comp = await solar.complete(
                    atomize.build_atom_messages(chunk["chunk_text"], n),
                    max_tokens=256,
                )
                content = (comp.message or {}).get("content") or ""
                qs = atomize.parse_atom_questions(content, n)
                if qs:
                    questions_by_chunk[str(chunk["id"])] = qs
                state["consecutive"] = 0
            except Exception as exc:  # noqa: BLE001 - 개별 실패는 그 청크만 건너뜀
                state["consecutive"] += 1
                if (
                    state["consecutive"] >= CIRCUIT_BREAK_THRESHOLD
                    and not state["broken"]
                ):
                    state["broken"] = True
                    logger.warning(
                        "원자 생성 연속 %d회 실패 — 잔여 청크 생략(회로차단): %s",
                        CIRCUIT_BREAK_THRESHOLD, exc,
                    )
                else:
                    logger.warning(
                        "원자 생성 실패 chunk=%s (그 청크만 건너뜀): %s",
                        chunk.get("id"), exc,
                    )
            # 4청크마다 하트비트 — 스테일 복구 오탐 재클레임 방지(D133).
            progress["count"] += 1
            if progress["count"] % 4 == 0:
                await common.touch_job(svc, job["id"])

    await asyncio.gather(*(_gen(c) for c in todo))

    if state["broken"]:
        # 회로차단 = 배치 실패(attempts 재시도 상속). 행 insert 이전이므로 정리할
        # chunk_atoms가 없고, files.status는 건드리지 않는다(D88 동형).
        await jobs._fail_job(svc, job["id"], "atom generation circuit break")
        return

    # 5. chunk_atoms insert(pending) — returning으로 id 회수(Qdrant 포인트 id).
    seq_by_chunk = {str(c["id"]): c["seq"] for c in todo}
    insert_rows: list[dict[str, Any]] = []
    for cid, qs in questions_by_chunk.items():
        for q in qs:
            insert_rows.append({
                "chunk_id": cid,
                "file_id": file_id,
                "chunk_seq": seq_by_chunk[cid],
                "question": q,
                "status": "pending",
            })
    if not insert_rows:
        # 전부 개별 실패로 질문 0개 — 배치는 실패가 아니다(마감).
        await _mark_job_done(svc, job["id"])
        return

    inserted = await svc.insert("chunk_atoms", insert_rows, returning=True)

    # ── 임베딩(embedding-passage) — 실패 = 배치 실패(attempts 재시도 상속) ──
    texts = [r["question"] for r in inserted]
    try:
        vectors = await embedding.embed_texts(texts, task_type="RETRIEVAL_DOCUMENT")
    except Exception as exc:  # noqa: BLE001 - 행 failed 후 잡 failed
        logger.exception("원자 임베딩 실패 file=%s", file_id)
        await _fail_atom_rows(svc, inserted)
        await jobs._fail_job(svc, job["id"], f"atom embed error: {exc}")
        return
    if len(vectors) != len(inserted):
        logger.error(
            "원자 임베딩 수 불일치 file=%s: %d vectors for %d atoms",
            file_id, len(vectors), len(inserted),
        )
        await _fail_atom_rows(svc, inserted)
        await jobs._fail_job(svc, job["id"], "atom embedding count mismatch")
        return

    # 벡터는 Qdrant chunk_atoms 컬렉션에만 — 포인트 id=원자 uuid(재시도 덮어쓰기),
    # 페이로드는 식별자만(질문 본문·경로 금지 — Qdrant 신뢰 경계 아님 불변식).
    points = [
        {
            "id": r["id"],
            "vector": v,
            "payload": {
                "atom_id": r["id"],
                "chunk_id": str(r["chunk_id"]),
                "file_id": str(file_id),
                "owner_id": str(owner_id) if owner_id else None,
            },
        }
        for r, v in zip(inserted, vectors, strict=True)
    ]
    try:
        await common._qdrant_upsert(points, collection=qdrant_store.COL_CHUNK_ATOMS)
    except Exception as exc:  # noqa: BLE001 - Qdrant 장애도 embed 실패와 동일 처리
        logger.exception("원자 Qdrant 업서트 실패 file=%s", file_id)
        await _fail_atom_rows(svc, inserted)
        await jobs._fail_job(svc, job["id"], f"atom qdrant error: {exc}")
        return

    # 6. 성공 행 update: status='embedded'.
    mark_sem = asyncio.Semaphore(8)

    async def _mark(atom_id: str) -> None:
        async with mark_sem:
            await svc.update(
                "chunk_atoms", {"id": f"eq.{atom_id}"}, {"status": "embedded"}
            )

    await asyncio.gather(*(_mark(r["id"]) for r in inserted))

    # D88 동형: 파일 status·chunk_done·_finalize_file 호출 금지(원자는 files.status와 무관).
    await _mark_job_done(svc, job["id"])
    logger.info(
        "원자 적재 file=%s: %d청크 → %d질문", file_id, len(questions_by_chunk),
        len(inserted),
    )


async def _mark_job_done(svc: ServiceClient, job_id: str) -> None:
    await svc.update(
        "jobs", {"id": f"eq.{job_id}"},
        {"status": "done", "updated_at": common._now_iso()},
    )


async def _fail_atom_rows(svc: ServiceClient, rows: list[dict[str, Any]]) -> None:
    for r in rows:
        await svc.update(
            "chunk_atoms", {"id": f"eq.{r['id']}"}, {"status": "failed"}
        )


async def _requeue_atoms(
    svc: ServiceClient, f: dict[str, Any], file_id: str
) -> str | None:
    """D129: 실패한 원자 행을 pending으로 리셋하고 atom_batch를 재팬아웃.

    _requeue_figures와 동형 — 잔여 atom_batch queued/running 잡이 있으면
    재팬아웃을 생략한다(리셋만). failed 행이 없으면 아무 것도 하지 않고 None.
    재팬아웃은 청크 seq 전 범위로 하되, atom_batch 핸들러는 embedded 원자가 있는
    청크만 스킵하고 리셋된 pending 행은 삭제 후 재생성하므로(task6-fix2), 리셋이
    무효화되지 않으면서 embedded 청크의 중복 생성도 없다.
    반환: 관측용 액션 문자열(없으면 None).
    """
    failed = await svc.count(
        "chunk_atoms", {"file_id": f"eq.{file_id}", "status": "eq.failed"}
    )
    if failed == 0:
        return None
    await svc.update(
        "chunk_atoms",
        {"file_id": f"eq.{file_id}", "status": "eq.failed"},
        {"status": "pending"},
    )
    existing = await svc.count(
        "jobs",
        {"target_id": f"eq.{file_id}", "kind": "eq.atom_batch",
         "status": "in.(queued,running)"},
    )
    if existing > 0:
        return "atoms_reset"
    total_chunks = await svc.count("file_chunks", {"file_id": f"eq.{file_id}"})
    asize = max(1, settings.atom_batch_size)
    # parent_job_id 생략은 의도적 — 원 split 잡은 이미 done이라 부모로 매달 대상이
    # 없다. _requeue_figures도 동일하게 parent 없이 재큐한다(동형 유지, task6-fix2).
    child_jobs = [
        {
            "owner_id": f.get("owner_id"),
            "kind": "atom_batch",
            "target_id": file_id,
            "batch_range": {"from_seq": start, "to_seq": min(start + asize, total_chunks)},
            "status": "queued",
            "space_ref": f.get("space_ref"),
        }
        for start in range(0, total_chunks, asize)
    ]
    await svc.insert("jobs", child_jobs, returning=False)
    return "atoms_requeued"
