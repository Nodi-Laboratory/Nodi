"""figure_batch 잡 — 교과서 도판 크롭 · 캡션 확정 · 임베딩 (D86, D93, D103, D118).

캡션 확정 경로는 노브(`figure_caption_generate_enabled`)로 갈린다:

- **off (기본, D103 2단 경로 보존)**: ① 파서가 caption/footnote로 라벨한 요소가
  가까이 있으면 그대로 쓰고(비전 판정 불필요), ② 없으면 비전 판정(figure_judge)이
  후보 중에서 고른다. 둘 다 없으면 캡션 없이 failed — 추측하지 않는다.
- **on (D118)**: 캡션 **생성**으로 일원화한다 — 전 pending 행을 대상으로
  figure_caption이 페이지 본문(page_text)을 컨텍스트로 캡션을 직접 생성한다.
  parsed 캡션(파서 라벨)은 더 이상 확정값이 아니라 **프롬프트 입력(힌트)이자
  생성 실패 시 폴백**으로 격하된다. 생성도 폴백도 없으면 캡션 없이 failed.
  판정 계열(judge_*) 미설정이면 생성 자체가 불가하므로 전 행 no-caption failed.

어느 경로든 임베딩→Qdrant→행 마감 코드는 공용이다(embed_text 단독 임베딩,
페이로드는 식별자만). figure 실패는 텍스트 인덱싱과 격리된다(files.status 불가침, D88).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ...config import get_settings
from ...db.client import ServiceClient
from .. import (
    app_settings,
    figure_caption,
    figure_judge,
    qdrant_store,
    upstage,
)
from . import common, jobs

logger = logging.getLogger("nodi.worker.figures")
settings = get_settings()

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
                "embed_text,image_path,match_kind,page_text"
            ),
            "order": "seq.asc",
        },
    )
    if not figures:
        # 재시도 시 이미 embedded면 select가 비어 스킵(행 단위 멱등) — 잡만 마감.
        await svc.update(
            "jobs", {"id": f"eq.{job['id']}"},
            {"status": "done", "updated_at": common._now_iso()},
        )
        return

    files = await svc.select(
        "files", {"id": f"eq.{file_id}", "select": "id,owner_id", "limit": "1"}
    )
    if not files:
        await jobs._fail_job(svc, job["id"], "file row missing")
        return
    owner_id = files[0].get("owner_id")

    overlay = await app_settings.get_overlay()
    to_embed: list[dict[str, Any]] = []  # {"row", "text", "patch"}

    if app_settings.as_bool(
        overlay, "figure_caption_generate_enabled",
        settings.figure_caption_generate_enabled,
    ):
        # ── D118: 캡션 생성 경로 — 전 pending 행을 생성 대상으로 일원화한다.
        #    parsed 캡션(파서 라벨)은 확정값이 아니라 프롬프트 힌트이자 생성 실패
        #    시 폴백으로 격하된다(모듈 독스트링 D118). judge 계열(judge_*) 미설정이면
        #    생성 자체가 불가 — 전 행 no-caption failed(D93 미설정 처리와 동형).
        if not figure_judge.is_configured():
            logger.info(
                "judge/caption 계열 미설정 — figure %d건 생성 스킵 file=%s",
                len(figures), file_id,
            )
            for row in figures:
                await svc.update(
                    "textbook_figures", {"id": f"eq.{row['id']}"},
                    {"status": "failed", "match_kind": "no-caption"},
                )
        else:
            try:
                items = []
                for row in figures:
                    ext = (row["image_path"].rsplit(".", 1)[-1] or "png").lower()
                    img = await svc.storage_download(
                        settings.storage_bucket, row["image_path"]
                    )
                    items.append({
                        "image_bytes": img,
                        "ext": ext,
                        "page_text": row.get("page_text") or "",
                        "parsed_caption": row.get("caption") or "",  # 힌트·폴백
                        "alt": row.get("alt") or "",
                    })
                concurrency = app_settings.as_int(
                    overlay, "figure_judge_concurrency",
                    settings.figure_judge_concurrency, 1, 32,
                )
                # 항목별 하트비트로 장기 잡 스테일 재클레임을 막는다(D120).
                captions = await figure_caption.caption_all(
                    items, concurrency=concurrency,
                    heartbeat=lambda: common.touch_job(svc, job["id"]),
                )
            except Exception as exc:  # noqa: BLE001 - 준비 실패 = 배치 실패(재시도 상속)
                logger.exception("figure 캡션 생성 실패 file=%s", file_id)
                for row in figures:
                    await svc.update(
                        "textbook_figures", {"id": f"eq.{row['id']}"},
                        {"status": "failed"},
                    )
                await jobs._fail_job(svc, job["id"], f"figure caption error: {exc}")
                return
            for row, cap in zip(figures, captions, strict=True):
                if cap:
                    # 생성 성공 → 생성 캡션 단독을 임베딩(판정 메타 없음).
                    to_embed.append({
                        "row": row,
                        "text": cap,
                        "patch": {
                            "id": row["id"],
                            "selected_index": None,
                            "judge_reason": None,
                            "match_kind": "generated",
                            "embed_text": cap,
                        },
                    })
                    continue
                # 생성 실패 — parsed 캡션이 있으면 폴백(D118), 없으면 캡션 없이 failed.
                parsed = (row.get("caption") or "").strip()
                if parsed:
                    to_embed.append({
                        "row": row,
                        "text": parsed,
                        "patch": {
                            "id": row["id"],
                            "selected_index": None,
                            "judge_reason": None,
                            "match_kind": "parsed",
                            "embed_text": parsed,
                        },
                    })
                else:
                    await svc.update(
                        "textbook_figures", {"id": f"eq.{row['id']}"},
                        {"status": "failed", "match_kind": "caption-error"},
                    )
    else:
        # ── D103: 캡션 확정 2단 경로(기존 판정 경로 — 이동 없이 보존).
        #    1순위 — 추출 시점에 파서 라벨(caption/footnote)로 이미 확정된 행
        #            (match_kind="parsed"). 판정 호출 없이 그대로 임베딩한다.
        #    2순위 — 남은 행은 비전 판정이 candidates에서 고른다(D93 경로).
        #    판정이 미설정이면 2순위 행만 캡션 없이 failed — 1순위 행은 영향 없다.
        #    (D93에서는 판정 미설정 시 배치 전체를 failed 처리했는데, 파싱 경로가
        #     생기면서 그 전제가 깨졌다.)
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
                await jobs._fail_job(svc, job["id"], f"figure judge error: {exc}")
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
            {"status": "done", "updated_at": common._now_iso()},
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
        await jobs._fail_job(svc, job["id"], f"figure embed error: {exc}")
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
        await jobs._fail_job(svc, job["id"], "figure embedding count mismatch")
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
        await common._qdrant_upsert(points, collection=qdrant_store.COL_TEXTBOOK_FIGURES)
    except Exception as exc:  # noqa: BLE001 - Qdrant 장애도 embed 실패와 동일 처리
        logger.exception("figure Qdrant 업서트 실패 file=%s", file_id)
        for e in to_embed:
            await svc.update(
                "textbook_figures", {"id": f"eq.{e['row']['id']}"},
                {"status": "failed"},
            )
        await jobs._fail_job(svc, job["id"], f"figure qdrant error: {exc}")
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

    # D88: 파일 status·chunk_done·jobs._finalize_file 호출 금지(figure는 files.status와 무관).
    await svc.update(
        "jobs", {"id": f"eq.{job['id']}"},
        {"status": "done", "updated_at": common._now_iso()},
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
