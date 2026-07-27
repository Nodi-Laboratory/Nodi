"""Background embedding worker (Stage 3b-1; Upstage+Qdrant 이전).

apscheduler polls `jobs(status='queued')` and processes them with the
service-role client (RLS bypass). Disabled when no service-role key.

Job flow (architecture §5, D11 — split then parallel batches):
  embedding_split:  download file -> extract text (PDF/이미지=Upstage Document
                    Parse, 평문=디코드) -> chunk -> insert file_chunks(pending)
                    + set chunk_total, status='embedding' -> create
                    embedding_batch child jobs.
  embedding_batch:  embed the batch's chunks (Upstage passage, 4096d) ->
                    벡터는 Qdrant file_chunks 컬렉션에 업서트(Supabase엔
                    상태만 기록, embedding 컬럼 미사용 — migration 0028) +
                    status='embedded', recompute file progress; when all
                    chunks resolved -> file status 'indexed' (or 'partial'
                    if some failed).

Concurrency: each poll claims up to `embedding_worker_concurrency` queued jobs
and runs them concurrently. Claiming flips status queued->running conditionally
so a job is processed once.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from ..config import get_settings
from ..db.client import ServiceClient, get_service_client
from . import (
    app_settings,
    embedding,
    figure_extract,
    figure_judge,
    qdrant_store,
    upstage,
)

logger = logging.getLogger("nodi.embedding_worker")
settings = get_settings()

_scheduler: AsyncIOScheduler | None = None
_poll_lock = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ---------------------------------------------------------------------------
# 텍스트 추출: PDF/이미지는 Upstage Document Parse(markdown, 스캔본 OCR 포함),
# 그 외는 평문 디코드. 추출 실패 = 빈 텍스트 -> split이 파일을 failed 처리.
# ---------------------------------------------------------------------------
async def _extract_text(data: bytes, mime: str | None, storage_path: str) -> str:
    name = (storage_path or "").lower()
    mime = mime or ""

    is_image = mime.startswith("image/") or name.endswith(
        (".png", ".jpg", ".jpeg", ".webp", ".gif")
    )
    is_pdf = name.endswith(".pdf") or mime.endswith("pdf")
    if is_image or is_pdf:
        try:
            # 스토리지 경로 규약 "{owner}/{file_id}/{name}" -> 실제 파일명.
            filename = (storage_path or "").split("/")[-1] or "document"
            return await upstage.parse_document(data, filename)
        except Exception:  # noqa: BLE001 - 잡 상태 머신 보존(파일 failed 경로)
            logger.exception("Document parse failed for %s", storage_path)
            return ""

    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="ignore")


# ---------------------------------------------------------------------------
# Qdrant 헬퍼 — 컬렉션 보장은 지연 1회, 업서트 실패 시 다음 시도에서 재보장.
# ---------------------------------------------------------------------------
_qdrant_ready = False


async def _qdrant_upsert(
    points: list[dict[str, Any]],
    collection: str = qdrant_store.COL_FILE_CHUNKS,
) -> None:
    global _qdrant_ready
    if not _qdrant_ready:
        await qdrant_store.ensure_collections()
        _qdrant_ready = True
    try:
        # D86: collection 기본값은 file_chunks(기존 호출부 하위호환), textbook
        # figure 경로만 COL_TEXTBOOK_FIGURES를 명시한다.
        await qdrant_store.upsert(collection, points)
    except Exception:
        _qdrant_ready = False  # 컬렉션 부재/일시 장애 대비 — 재시도 시 재보장
        raise


async def _qdrant_delete_file_points(
    file_id: str, collection: str = qdrant_store.COL_FILE_CHUNKS
) -> None:
    """재분할·삭제 전 해당 파일의 기존 Qdrant 포인트 정리 — best-effort.

    스테일 포인트가 남아도 본문 없는 페이로드뿐이고 검색 후 Supabase 재조회
    (RLS)에서 걸러지지만, 무한히 쌓이지 않도록 여기서 지운다. collection 기본값은
    file_chunks(기존 호출부·테스트 하위호환) — textbook figure 경로는
    COL_TEXTBOOK_FIGURES를 넘겨 figure 임베딩 포인트를 정리한다(D86).
    """
    try:
        from qdrant_client import models

        await qdrant_store.get_client().delete(
            collection_name=collection,
            points_selector=models.FilterSelector(
                filter=models.Filter(
                    must=[
                        models.FieldCondition(
                            key="file_id", match=models.MatchValue(value=str(file_id))
                        )
                    ]
                )
            ),
        )
    except Exception:  # noqa: BLE001 - 정리는 최적화일 뿐, split/삭제를 막지 않는다
        logger.warning(
            "Qdrant 포인트 정리 실패 file=%s collection=%s",
            file_id, collection, exc_info=True,
        )


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


# ---------------------------------------------------------------------------
# embedding_split
# ---------------------------------------------------------------------------
async def _store_session_chunks(
    svc: ServiceClient, job: dict[str, Any], f: dict[str, Any],
    chunks: list[str],
) -> None:
    """D83: user_upload 청크를 'stored'로 저장만 한다(임베딩 팬아웃 생략).

    D84: session_id가 있으면 세션 합산 예산(문자)을 검사해 초과 시 청크 저장
    없이 failed + 한국어 사유(프론트 칩이 그대로 노출). 터미널 상태는
    'indexed'를 재사용한다 — user_upload에선 "세션 컨텍스트 준비 완료" 의미
    (프론트 FileStatus·폴링·재시도 판별 재사용을 위해 상태값을 늘리지 않음).
    """
    file_id = f["id"]
    total_chars = sum(len(c) for c in chunks)
    session_id = f.get("session_id")
    if session_id:
        overlay = await app_settings.get_overlay()
        budget = app_settings.as_int(
            overlay, "session_context_max_chars",
            settings.session_context_max_chars, 10_000, 300_000,
        )
        # 진행 중인 이 파일은 위에서 status='splitting'으로 세팅됐고 아래
        # status='eq.indexed' 필터가 자기 자신을 이미 배제하므로, 별도 id!=self
        # 필터는 불필요하다(합산은 세션의 다른 indexed user_upload만 대상).
        siblings = await svc.select(
            "files",
            {"session_id": f"eq.{session_id}", "kind": "eq.user_upload",
             "status": "eq.indexed", "select": "id,context_chars"},
        )
        used = sum(r.get("context_chars") or 0 for r in siblings)
        if used + total_chars > budget:
            remaining = max(0, budget - used)
            await svc.update(
                "files", {"id": f"eq.{file_id}"},
                {"status": "failed",
                 "error": (
                     f"세션 컨텍스트 예산 초과: 이 파일 약 {total_chars:,}자, "
                     f"세션 잔여 {remaining:,}자. 파일을 삭제하거나 더 작은 "
                     "파일로 다시 업로드하세요."
                 )},
            )
            await svc.update(
                "jobs", {"id": f"eq.{job['id']}"},
                {"status": "done", "updated_at": _now_iso()},
            )
            return

    rows = [
        {"file_id": file_id, "seq": i, "chunk_text": c, "status": "stored"}
        for i, c in enumerate(chunks)
    ]
    for i in range(0, len(rows), 500):
        await svc.insert("file_chunks", rows[i : i + 500], returning=False)
    await svc.update(
        "files", {"id": f"eq.{file_id}"},
        {"status": "indexed", "chunk_total": len(chunks),
         "chunk_done": len(chunks), "context_chars": total_chars},
    )
    await svc.update(
        "jobs", {"id": f"eq.{job['id']}"},
        {"status": "done", "updated_at": _now_iso()},
    )
    logger.info(
        "세션 파일 저장: file=%s chunks=%d chars=%d (임베딩 생략)",
        file_id, len(chunks), total_chars,
    )


async def _fanout_figures(
    svc: ServiceClient,
    job: dict[str, Any],
    f: dict[str, Any],
    elements: list[dict[str, Any]],
    overlay: dict[str, Any],
) -> None:
    """D86: textbook figure 추출 → 크롭 업로드 → textbook_figures insert → figure_batch 팬아웃.

    호출부(_handle_split)가 try/except로 감싸므로 여기서의 예외는 텍스트 인덱싱을
    막지 않는다(D88). 킬 스위치(figure_pipeline_enabled)가 off면 즉시 생략.
    """
    file_id = f["id"]
    if not app_settings.as_bool(
        overlay, "figure_pipeline_enabled", settings.figure_pipeline_enabled
    ):
        logger.info("figure 파이프라인 kill switch off — figure 생략 file=%s", file_id)
        return

    records = figure_extract.extract_figures(elements)
    if not records:
        return
    owner_id = f.get("owner_id")

    # 레코드별 크롭 업로드(경로 결정적 pN_eM.ext, upsert) + textbook_figures 행.
    # seq는 0-base 열거 순서(figure_batch batch_range 팬아웃 기준). image_bytes/ext는
    # Storage가 원본이므로 행에 넣지 않는다.
    rows: list[dict[str, Any]] = []
    for seq, r in enumerate(records):
        ext = r["ext"]
        image_path = (
            f"{owner_id}/{file_id}/figures/p{r['page']}_e{r['element_id']}.{ext}"
        )
        content_type = "image/jpeg" if ext == "jpg" else "image/png"
        await svc.storage_upload(
            settings.storage_bucket, image_path, r["image_bytes"], content_type
        )
        rows.append({
            "file_id": file_id,
            "seq": seq,
            "page": r["page"],
            "element_id": r["element_id"],
            "bbox": r["bbox"],
            "caption": r["caption"],
            "alt": r["alt"],
            "description": r["description"],
            "figure_type": r["figure_type"],
            "heading": r["heading"],
            "candidates": r["candidates"],
            "embed_text": r["embed_text"],
            "match_kind": r["match_kind"],
            "image_path": image_path,
            "status": "pending",
        })
    await svc.insert("textbook_figures", rows, returning=False)

    # figure_batch 잡 팬아웃 — seq 범위(embedding_batch 팬아웃과 동형).
    bsize = max(1, settings.figure_batch_size)
    n = len(rows)
    child_jobs = [
        {
            "owner_id": owner_id,
            "kind": "figure_batch",
            "target_id": file_id,
            "parent_job_id": job["id"],
            "batch_range": {"from_seq": start, "to_seq": min(start + bsize, n)},
            "status": "queued",
            "space_ref": f.get("space_ref"),
        }
        for start in range(0, n, bsize)
    ]
    await svc.insert("jobs", child_jobs, returning=False)
    logger.info(
        "figure 팬아웃 file=%s -> %d figures, %d batches", file_id, n, len(child_jobs)
    )


async def _handle_split(svc: ServiceClient, job: dict[str, Any]) -> None:
    file_id = job["target_id"]
    files = await svc.select(
        "files",
        {"id": f"eq.{file_id}",
         "select": "id,owner_id,storage_path,mime,space_ref,kind,session_id",
         "limit": "1"},
    )
    if not files:
        await _fail_job(svc, job["id"], "file row missing")
        return
    f = files[0]
    is_textbook = f.get("kind") == "textbook"

    # (구 D65 차원 가드 폐기 — 벡터는 Qdrant에만 저장하고 차원은 Upstage
    #  EMBED_DIM=4096 고정. 검증은 upstage.embed_texts + Qdrant 컬렉션이 수행.)

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
    await _qdrant_delete_file_points(file_id)

    # D86: textbook figure 멱등 정리 + 중복 팬아웃 가드(embedding_batch 조기 done
    # 가드와 동형). 잔여 figure_batch queued/running 잡이 있으면 이미 팬아웃됐으므로
    # figure 행·Qdrant를 그대로 두고 재팬아웃만 건너뛴다(그 잡들이 소비할 상태).
    # 없으면 이전 크래시의 부분 figure 상태를 정리하고 재추출한다. 크롭 Storage
    # 객체는 경로가 결정적(pN_eM)이고 storage_upload가 upsert라 재실행 시 덮어써지므로
    # 별도 삭제가 불필요하다.
    skip_figure_fanout = False
    if is_textbook:
        existing_fig_batches = await svc.count(
            "jobs",
            {"target_id": f"eq.{file_id}", "kind": "eq.figure_batch",
             "status": "in.(queued,running)"},
        )
        if existing_fig_batches > 0:
            skip_figure_fanout = True
        else:
            await svc.delete("textbook_figures", {"file_id": f"eq.{file_id}"})
            await _qdrant_delete_file_points(
                file_id, collection=qdrant_store.COL_TEXTBOOK_FIGURES
            )

    await svc.update("files", {"id": f"eq.{file_id}"}, {"status": "splitting"})

    data = await svc.storage_download(settings.storage_bucket, f["storage_path"])
    # D86: textbook은 enhanced 구조화 파싱(markdown+elements 1회 공유) — 텍스트
    # 청킹 입력은 figure를 제외한 요소 텍스트(빈 결과면 전체 markdown 폴백 계약).
    # 그 외 kind는 기존 _extract_text 경로 그대로.
    elements: list[dict[str, Any]] = []
    if is_textbook:
        filename = (f.get("storage_path") or "").split("/")[-1] or "document"
        markdown, elements = await upstage.parse_document_full(data, filename)
        text = figure_extract.text_from_elements(elements) or markdown
    else:
        text = await _extract_text(data, f.get("mime"), f["storage_path"])
    # D65 new-only: chunk size/overlap come from the admin overlay and apply to
    # THIS (new) job; existing chunks are untouched until re-uploaded.
    overlay = await app_settings.get_overlay()

    # D88 figure 팬아웃 — 텍스트 청킹·embedding_batch 팬아웃 이전에, 독립 try/except로.
    # 순서 근거: 텍스트가 "no extractable text"로 파일을 failed시켜도 figure는 이미
    # 팬아웃됨(이미지 위주 교과서 대응). figure 실패는 텍스트 인덱싱을 절대 막지 않는다.
    if is_textbook and not skip_figure_fanout:
        try:
            await _fanout_figures(svc, job, f, elements, overlay)
        except Exception:  # noqa: BLE001 - D88: figure 실패 격리(텍스트 인덱싱 무영향)
            logger.exception(
                "figure 팬아웃 실패 — 텍스트 인덱싱은 계속 file=%s", file_id
            )

    chunk_size = app_settings.as_int(
        overlay, "chunk_size_chars", settings.chunk_size_chars, 400, 4000
    )
    # D83: user_upload는 전문 이어붙이기용 — 오버랩은 중복 텍스트만 만들므로 0.
    is_session_upload = f.get("kind") == "user_upload"
    chunk_overlap = 0 if is_session_upload else app_settings.as_int(
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

    # D83: user_upload는 임베딩·Qdrant 없이 저장만 — 세션 전문 주입이 소비한다.
    if is_session_upload:
        await _store_session_chunks(svc, job, f, chunks)
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
        # 페이로드 owner_id는 파일 행에서 파생(스코핑 필터 참고용 —
        # Qdrant 페이로드는 신뢰 경계가 아니다).
        files = await svc.select(
            "files", {"id": f"eq.{file_id}", "select": "id,owner_id", "limit": "1"}
        )
        if not files:
            await _fail_job(svc, job["id"], "file row missing")
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
            await _qdrant_upsert(points)
        except Exception as exc:  # noqa: BLE001 - Qdrant 장애도 embed 실패와 동일 처리
            logger.exception("Qdrant upsert failed file=%s", file_id)
            for c in chunks:
                await svc.update(
                    "file_chunks", {"id": f"eq.{c['id']}"}, {"status": "failed"}
                )
            await _finalize_file(svc, file_id)
            await _fail_job(svc, job["id"], f"qdrant error: {exc}")
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

    await _finalize_file(svc, file_id)
    await svc.update(
        "jobs", {"id": f"eq.{job['id']}"},
        {"status": "done", "updated_at": _now_iso()},
    )


# ---------------------------------------------------------------------------
# figure_batch (D86/D88 — textbook figure 판정·임베딩·Qdrant 적재)
# ---------------------------------------------------------------------------
async def _handle_figure_batch(svc: ServiceClient, job: dict[str, Any]) -> None:
    """textbook_figures seq 범위의 pending 행을 판정→임베딩→Qdrant 적재.

    _handle_batch를 본떴다. D93(사용자 결정): 판정이 캡션을 확정하는 **게이트**다
    — 미설정이면 배치 전체 failed(업로드 게이트가 1차 방어, 여기는 업로드 후
    env가 제거된 엣지 방어), 판정 실패(judge-error)·해당없음(judge-none) 행은
    임베딩할 캡션이 없으므로 임베딩 없이 failed로 확정한다(캡션 없는 figure는
    검색에 노출하지 않는다 — failed라 retry 경로가 재판정할 수 있다).
    임베딩/Qdrant 실패는 행 failed + 잡 failed(attempts 재시도 규약 상속). 파일
    status·chunk_done·_finalize_file은 건드리지 않는다 — figure는 files.status와 무관.
    """
    file_id = job["target_id"]
    rng = job.get("batch_range") or {}
    from_seq = int(rng.get("from_seq", 0))
    to_seq = int(rng.get("to_seq", 0))

    figures = await svc.select(
        "textbook_figures",
        {
            "file_id": f"eq.{file_id}",
            "and": f"(seq.gte.{from_seq},seq.lt.{to_seq})",
            "status": "eq.pending",
            "select": (
                "id,seq,caption,alt,description,heading,candidates,"
                "embed_text,image_path,match_kind"
            ),
            "order": "seq.asc",
        },
    )
    if not figures:
        # 재시도 시 이미 embedded면 select가 비어 스킵(행 단위 멱등) — 잡만 마감.
        await svc.update(
            "jobs", {"id": f"eq.{job['id']}"},
            {"status": "done", "updated_at": _now_iso()},
        )
        return

    files = await svc.select(
        "files", {"id": f"eq.{file_id}", "select": "id,owner_id", "limit": "1"}
    )
    if not files:
        await _fail_job(svc, job["id"], "file row missing")
        return
    owner_id = files[0].get("owner_id")

    # ── D103: 캡션 확정 2단 경로.
    #    1순위 — 추출 시점에 파서 라벨(caption/footnote)로 이미 확정된 행
    #            (match_kind="parsed"). 판정 호출 없이 그대로 임베딩한다.
    #    2순위 — 남은 행은 비전 판정이 candidates에서 고른다(D93 경로).
    #    판정이 미설정이면 2순위 행만 캡션 없이 failed — 1순위 행은 영향 없다.
    #    (D93에서는 판정 미설정 시 배치 전체를 failed 처리했는데, 파싱 경로가
    #     생기면서 그 전제가 깨졌다.)
    to_embed: list[dict[str, Any]] = []  # {"row", "text", "patch"}
    need_judge: list[dict[str, Any]] = []
    for row in figures:
        parsed_text = (row.get("embed_text") or "").strip()
        if row.get("match_kind") == "parsed" and parsed_text:
            to_embed.append({
                "row": row,
                "text": parsed_text,
                # patch shape은 판정 경로와 동일해야 한다 — 아래 _mark가 네 키를
                # 모두 읽는다. 파싱 경로는 판정을 안 거쳤으므로 판정 메타는 None.
                "patch": {
                    "id": row["id"],
                    "selected_index": None,
                    "judge_reason": None,
                    "match_kind": "parsed",
                    "embed_text": parsed_text,
                },
            })
        else:
            need_judge.append(row)

    if need_judge and not figure_judge.is_configured():
        # 판정 없이 캡션을 지어내지 않는다 — 해당 행만 failed로 남긴다.
        logger.info(
            "judge 미설정 — 파서 라벨 없는 figure %d건 스킵 (파싱 캡션 %d건은 진행) file=%s",
            len(need_judge), len(to_embed), file_id,
        )
        for row in need_judge:
            await svc.update(
                "textbook_figures", {"id": f"eq.{row['id']}"},
                {"status": "failed", "match_kind": "no-caption"},
            )
        need_judge = []

    overlay = await app_settings.get_overlay()
    judgments: list[dict | None] = []
    if need_judge:
        try:
            items = []
            for row in need_judge:
                ext = (row["image_path"].rsplit(".", 1)[-1] or "png").lower()
                img = await svc.storage_download(
                    settings.storage_bucket, row["image_path"]
                )
                items.append({
                    "candidates": row.get("candidates") or [],
                    "image_bytes": img,
                    "ext": ext,
                })
            concurrency = app_settings.as_int(
                overlay, "figure_judge_concurrency",
                settings.figure_judge_concurrency, 1, 32,
            )
            judgments = await figure_judge.judge_all(items, concurrency=concurrency)
        except Exception as exc:  # noqa: BLE001 - 판정 준비 실패 = 배치 실패(재시도 상속)
            logger.exception("figure 판정 실패 file=%s", file_id)
            # D103: 판정이 필요했던 행만 failed. 파서 라벨로 이미 확정된 행은
            # 판정과 무관하므로 같이 죽이지 않는다.
            for row in need_judge:
                await svc.update(
                    "textbook_figures", {"id": f"eq.{row['id']}"}, {"status": "failed"}
                )
            await _fail_job(svc, job["id"], f"figure judge error: {exc}")
            return

    # ── 판정 반영(D93): 선택된 행만 임베딩 대상. judge-error(개별 실패·회로차단)
    #    ·judge-none(-1 해당없음)은 캡션이 없으므로 임베딩 없이 failed 확정 —
    #    판정 메타는 남겨 재판정·디버그 근거로 쓴다.
    for i, row in enumerate(need_judge):
        j = judgments[i]
        if j is None:
            await svc.update(
                "textbook_figures", {"id": f"eq.{row['id']}"},
                {"status": "failed", "selected_index": None,
                 "judge_reason": None, "match_kind": "judge-error"},
            )
            continue
        idx = j["selected_index"]
        et = figure_judge.final_embed_text(row, idx)
        if not et:
            await svc.update(
                "textbook_figures", {"id": f"eq.{row['id']}"},
                {"status": "failed", "selected_index": -1,
                 "judge_reason": j.get("reason"), "match_kind": "judge-none"},
            )
            continue
        to_embed.append({
            "row": row,
            "text": et,
            "patch": {
                "id": row["id"],
                "selected_index": idx,
                "judge_reason": j.get("reason"),
                "match_kind": "judge",
                "embed_text": et,
            },
        })

    if not to_embed:
        # 판정은 정상 수행됐고 임베딩할 캡션이 없을 뿐 — 잡은 마감(done).
        await svc.update(
            "jobs", {"id": f"eq.{job['id']}"},
            {"status": "done", "updated_at": _now_iso()},
        )
        return

    # ── 임베딩(embedding-passage) — 실패 = 배치 실패(attempts 재시도 상속) ──
    embed_texts = [e["text"] for e in to_embed]
    try:
        vectors = await upstage.embed_passages(embed_texts)
    except Exception as exc:  # noqa: BLE001 - 행 failed 처리 후 잡 failed
        logger.exception("figure 임베딩 실패 file=%s", file_id)
        for e in to_embed:
            await svc.update(
                "textbook_figures", {"id": f"eq.{e['row']['id']}"},
                {"status": "failed"},
            )
        await _fail_job(svc, job["id"], f"figure embed error: {exc}")
        return
    if len(vectors) != len(to_embed):
        logger.error(
            "figure 임베딩 수 불일치 file=%s: %d vectors for %d figures",
            file_id, len(vectors), len(to_embed),
        )
        for e in to_embed:
            await svc.update(
                "textbook_figures", {"id": f"eq.{e['row']['id']}"},
                {"status": "failed"},
            )
        await _fail_job(svc, job["id"], "figure embedding count mismatch")
        return

    # 벡터는 Qdrant textbook_figures 컬렉션에만 — 포인트 id=행 uuid(재시도 덮어쓰기),
    # 페이로드는 식별자만(캡션·경로·본문 금지 — Qdrant 신뢰 경계 아님 불변식).
    points = [
        {
            "id": e["row"]["id"],
            "vector": v,
            "payload": {
                "figure_id": e["row"]["id"],
                "file_id": str(file_id),
                "owner_id": str(owner_id) if owner_id else None,
            },
        }
        for e, v in zip(to_embed, vectors, strict=True)
    ]
    try:
        await _qdrant_upsert(points, collection=qdrant_store.COL_TEXTBOOK_FIGURES)
    except Exception as exc:  # noqa: BLE001 - Qdrant 장애도 embed 실패와 동일 처리
        logger.exception("figure Qdrant 업서트 실패 file=%s", file_id)
        for e in to_embed:
            await svc.update(
                "textbook_figures", {"id": f"eq.{e['row']['id']}"},
                {"status": "failed"},
            )
        await _fail_job(svc, job["id"], f"figure qdrant error: {exc}")
        return

    # ── 성공 행 update: status='embedded' + 판정 메타 + embed_text ──
    sem = asyncio.Semaphore(8)

    async def _mark(patch: dict[str, Any]) -> None:
        async with sem:
            await svc.update(
                "textbook_figures",
                {"id": f"eq.{patch['id']}"},
                {
                    "status": "embedded",
                    "selected_index": patch["selected_index"],
                    "judge_reason": patch["judge_reason"],
                    "match_kind": patch["match_kind"],
                    "embed_text": patch["embed_text"],
                },
            )

    await asyncio.gather(*(_mark(e["patch"]) for e in to_embed))

    # D88: 파일 status·chunk_done·_finalize_file 호출 금지(figure는 files.status와 무관).
    await svc.update(
        "jobs", {"id": f"eq.{job['id']}"},
        {"status": "done", "updated_at": _now_iso()},
    )


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


async def _requeue_figures(
    svc: ServiceClient, f: dict[str, Any], file_id: str
) -> str | None:
    """D86: textbook 실패 figure 행을 pending으로 리셋하고 figure_batch 재팬아웃.

    중복 잡 가드는 split과 동일 — 잔여 figure_batch queued/running 잡이 있으면
    재팬아웃을 생략한다(리셋만). failed 행이 없으면 아무 것도 하지 않고 None.
    재팬아웃은 seq 전 범위로 하되, figure_batch 핸들러가 이미 embedded 행을
    자동 스킵하므로 pending(=리셋된 실패분)만 재처리된다(행 단위 멱등).
    반환: 관측용 액션 문자열(없으면 None).
    """
    failed = await svc.count(
        "textbook_figures", {"file_id": f"eq.{file_id}", "status": "eq.failed"}
    )
    if failed == 0:
        return None
    await svc.update(
        "textbook_figures",
        {"file_id": f"eq.{file_id}", "status": "eq.failed"},
        {"status": "pending"},
    )
    existing = await svc.count(
        "jobs",
        {"target_id": f"eq.{file_id}", "kind": "eq.figure_batch",
         "status": "in.(queued,running)"},
    )
    if existing > 0:
        return "figures_reset"
    total_figures = await svc.count(
        "textbook_figures", {"file_id": f"eq.{file_id}"}
    )
    bsize = max(1, settings.figure_batch_size)
    child_jobs = [
        {
            "owner_id": f.get("owner_id"),
            "kind": "figure_batch",
            "target_id": file_id,
            "batch_range": {"from_seq": start, "to_seq": min(start + bsize, total_figures)},
            "status": "queued",
            "space_ref": f.get("space_ref"),
        }
        for start in range(0, total_figures, bsize)
    ]
    await svc.insert("jobs", child_jobs, returning=False)
    return "figures_requeued"


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
        await _finalize_file(svc, file_id)
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
        figure_action = await _requeue_figures(svc, f, file_id)
        if figure_action:
            action = f"{action}+{figure_action}"
    return action


# ---------------------------------------------------------------------------
# Poll loop
# ---------------------------------------------------------------------------
async def _process(svc: ServiceClient, job: dict[str, Any]) -> None:
    try:
        if job["kind"] == "embedding_split":
            await _handle_split(svc, job)
        elif job["kind"] == "embedding_batch":
            await _handle_batch(svc, job)
        elif job["kind"] == "figure_batch":
            await _handle_figure_batch(svc, job)
        else:
            await _fail_job(svc, job["id"], f"unknown kind {job['kind']}")
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
                    {"status": "queued", "updated_at": _now_iso()},
                )
            else:
                await _fail_job(svc, job["id"], str(exc))
                await _fail_file_for_job(svc, job, str(exc) or "split failed")
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

