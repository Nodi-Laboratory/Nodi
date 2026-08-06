"""embedding_split 잡 — 다운로드 → 텍스트 추출 → 청킹 → 자식 잡 팬아웃.

kind에 따라 갈린다: user_upload는 청킹까지만(세션 전문 주입용, D83),
class_material·textbook은 embedding_batch 자식 잡을 만든다. textbook은
추가로 figure_batch를 팬아웃한다(D86).
"""

from __future__ import annotations

import logging
from typing import Any

from ...config import get_settings
from ...db.client import ServiceClient
from .. import (
    app_settings,
    embedding,
    figure_extract,
    qdrant_store,
    semantic_chunker,
    upstage,
)
from . import common, jobs

logger = logging.getLogger("nodi.worker.split")
settings = get_settings()

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
            # D195: 상한 180K자 ≈ 78K 토큰(한국어 최악 2.31자/토큰) — solar-pro3
            # 윈도(131,072)의 60%. 옛 300K는 윈도를 통째로 먹었다.
            settings.session_context_max_chars, 10_000, 180_000,
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
                {"status": "done", "updated_at": common._now_iso()},
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
        {"status": "done", "updated_at": common._now_iso()},
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

    # D131: 캡션 비전 생성용 페이지 본문(figure 워커가 프롬프트 컨텍스트로 쓴다).
    # extract_figures 레코드 shape은 불변이므로 page_texts에서 별도로 얻어 rows에만
    # 싣는다. 텍스트 없는 페이지는 '' 폴백.
    page_map = figure_extract.page_texts(
        elements, settings.figure_page_text_max_chars
    )

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
            # candidates(판정 후보)는 D121로 제거 — 컬럼 기본값('[]')이 채운다.
            "embed_text": r["embed_text"],
            "match_kind": r["match_kind"],
            "page_text": page_map.get(r["page"], ""),  # D131
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


async def _fanout_atom_jobs(
    svc: ServiceClient, job: dict[str, Any], f: dict[str, Any],
    file_id: str, total_chunks: int,
) -> int:
    """D129: atom_batch 자식 잡을 seq 범위로 팬아웃(embedding_batch와 동형).

    반환: 만든 배치 수. 호출부는 D88 격리를 위해 try/except로 감싼다(원자화 실패가
    텍스트 인덱싱을 막지 않는다).
    """
    asize = max(1, settings.atom_batch_size)
    atom_jobs = [
        {
            "owner_id": f.get("owner_id"),
            "kind": "atom_batch",
            "target_id": file_id,
            "parent_job_id": job["id"],
            "batch_range": {"from_seq": start, "to_seq": min(start + asize, total_chunks)},
            "status": "queued",
            "space_ref": f.get("space_ref"),
        }
        for start in range(0, total_chunks, asize)
    ]
    await svc.insert("jobs", atom_jobs, returning=False)
    logger.info("원자 팬아웃 file=%s -> %d batches", file_id, len(atom_jobs))
    return len(atom_jobs)


async def _handle_split(svc: ServiceClient, job: dict[str, Any]) -> None:
    file_id = job["target_id"]
    files = await svc.select(
        "files",
        {"id": f"eq.{file_id}",
         "select": "id,owner_id,storage_path,mime,space_ref,kind,session_id",
         "limit": "1"},
    )
    if not files:
        await jobs._fail_job(svc, job["id"], "file row missing")
        return
    f = files[0]
    is_textbook = f.get("kind") == "textbook"

    # (구 D65 차원 가드 폐기 — 벡터는 Qdrant에만 저장하고 차원은 Upstage
    #  차원은 upstage.EMBED_DIM. 검증은 upstage.embed_texts + Qdrant 컬렉션이 수행.)

    # Idempotency (crash recovery): if batch jobs already exist for this file the
    # split already fanned out — just mark this (re-queued) split done. Otherwise
    # clear any partial chunks from a crashed prior split and start fresh (no
    # chunk is embedded before batch jobs exist, so deleting is safe).
    existing_batches = await svc.count(
        "jobs", {"target_id": f"eq.{file_id}", "kind": "eq.embedding_batch"}
    )
    if existing_batches > 0:
        # (task6-fix2) 조기 done 전에 atom_batch 팬아웃 갭을 메운다 —
        # embedding_batch를 넣고 atom_batch를 넣기 전에 크래시하면, 재큐된 split이
        # 여기서 조기 반환하며 atom 팬아웃을 영구 스킵한다(figure의
        # skip_figure_fanout 가드와 동형). 킬스위치 on이고 atom_batch가 아직 0이며
        # 청크가 있으면 atom_batch만 채운다. D88 격리(try/except)로 감싼다.
        try:
            overlay = await app_settings.get_overlay()
            if app_settings.as_bool(
                overlay, "atom_rag_enabled", settings.atom_rag_enabled
            ):
                atom_batches = await svc.count(
                    "jobs", {"target_id": f"eq.{file_id}", "kind": "eq.atom_batch"}
                )
                total_chunks = await svc.count(
                    "file_chunks", {"file_id": f"eq.{file_id}"}
                )
                if atom_batches == 0 and total_chunks > 0:
                    await _fanout_atom_jobs(svc, job, f, file_id, total_chunks)
        except Exception:  # noqa: BLE001 - D129: 원자 팬아웃 보정 실패 격리
            logger.exception(
                "원자 팬아웃 보정 실패 — 텍스트 인덱싱은 계속 file=%s", file_id
            )
        await svc.update(
            "jobs", {"id": f"eq.{job['id']}"},
            {"status": "done", "updated_at": common._now_iso()},
        )
        logger.info("split file=%s already fanned out; marking done", file_id)
        return
    await svc.delete("file_chunks", {"file_id": f"eq.{file_id}"})
    await common._qdrant_delete_file_points(file_id)
    # D129: chunk_atoms 포인트도 정리(행은 file_chunks delete의 FK CASCADE로 함께
    # 지워진다 — 여기서는 Qdrant 잔여 포인트만).
    await common._qdrant_delete_file_points(
        file_id, collection=qdrant_store.COL_CHUNK_ATOMS
    )

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
            await common._qdrant_delete_file_points(
                file_id, collection=qdrant_store.COL_TEXTBOOK_FIGURES
            )

    await svc.update("files", {"id": f"eq.{file_id}"}, {"status": "splitting"})

    data = await svc.storage_download(settings.storage_bucket, f["storage_path"])
    # D86: textbook은 enhanced 구조화 파싱(markdown+elements 1회 공유) — 텍스트
    # 청킹 입력은 figure를 제외한 요소 텍스트(빈 결과면 전체 markdown 폴백 계약).
    # 그 외 kind는 기존 common._extract_text 경로 그대로.
    elements: list[dict[str, Any]] = []
    if is_textbook:
        filename = (f.get("storage_path") or "").split("/")[-1] or "document"
        markdown, elements = await upstage.parse_document_full(data, filename)
        text = figure_extract.text_from_elements(elements) or markdown
    else:
        text = await common._extract_text(data, f.get("mime"), f["storage_path"])
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

    # D132: LLM 의미 청킹 분기. 노브 on이고 세션 업로드가 아니며 크기 가드 이내일
    # 때만 경계를 재조정한다(비용·지연 방어). 어떤 실패든 정규식 폴백으로 삼켜
    # 인덱싱을 절대 막지 않는다(인덱싱 불가침 — D88 동형).
    chunks: list[str] = []
    sem_on = app_settings.as_bool(
        overlay, "semantic_chunking_enabled", settings.semantic_chunking_enabled
    )
    sem_max = app_settings.as_int(
        overlay, "semantic_chunking_max_chars",
        settings.semantic_chunking_max_chars, 10_000, 500_000,
    )
    if sem_on and not is_session_upload and len(text) <= sem_max:
        try:
            chunks = await semantic_chunker.chunk_text_semantic(
                text, chunk_size, chunk_overlap,
                heartbeat=lambda: common.touch_job(svc, job["id"]),
            )
        except Exception:  # noqa: BLE001 - D132: 의미 청킹 실패 격리(정규식 폴백)
            logger.exception("의미 청킹 실패 — 정규식 폴백 file=%s", file_id)
            chunks = []
    if not chunks:
        chunks = embedding.chunk_text(text, chunk_size, chunk_overlap)

    if not chunks:
        await svc.update(
            "files",
            {"id": f"eq.{file_id}"},
            {"status": "failed", "error": "no extractable text"},
        )
        await svc.update(
            "jobs", {"id": f"eq.{job['id']}"},
            {"status": "done", "updated_at": common._now_iso()},
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
    # D195: 잡 하나가 맡는 청크 수는 운영 노브다 — 잡 안에서 요청 100개 단위로
    # 다시 쪼개 동시에 보내므로, 이 값은 "요청 몇 건을 한 잡에 묶는가"에 가깝다.
    bsize = app_settings.as_int(
        overlay, "embedding_batch_size", settings.embedding_batch_size, 50, 2000
    )
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

    # D129: 원자 질문 팬아웃 — 실패해도 텍스트 인덱싱을 막지 않는다(D88 동형).
    try:
        if app_settings.as_bool(overlay, "atom_rag_enabled", settings.atom_rag_enabled):
            await _fanout_atom_jobs(svc, job, f, file_id, len(chunks))
    except Exception:  # noqa: BLE001 - D129: 원자화 실패 격리
        logger.exception("원자 팬아웃 실패 — 텍스트 인덱싱은 계속 file=%s", file_id)

    await svc.update(
        "jobs", {"id": f"eq.{job['id']}"},
        {"status": "done", "updated_at": common._now_iso()},
    )
    logger.info("split file=%s -> %d chunks, %d batches", file_id, len(chunks),
                len(child_jobs))
