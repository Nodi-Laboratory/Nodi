"""강의 클립 인제스트 워커 (D149) — figures.py 골격 미러.

lecture_parse: EBS 페이지 GET+파싱 → lecture_clips(pending) 생성 → lecture_embed 팬아웃.
lecture_embed: 클립 제목 embedding-passage → Qdrant lecture_clips → 행 embedded.
실패는 lecture_videos/lecture_clips.status로 격리 — files.status 절대 안 건드림(D88 동형).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from ...config import get_settings
from .. import app_settings, lecture_parse, qdrant_store, subtitle_parse, upstage
from . import common, jobs

logger = logging.getLogger("nodi.worker.lectures")
settings = get_settings()


async def _handle_lecture_parse(svc: Any, job: dict[str, Any]) -> None:
    video_id = job["target_id"]
    rows = await svc.select("lecture_videos",
        {"id": f"eq.{video_id}", "select": "id,page_url,subtitle_path,title,status", "limit": "1"})
    if not rows:
        await jobs._fail_job(svc, job["id"], "lecture video row missing")
        return
    video = rows[0]

    overlay = await app_settings.get_overlay()
    if not app_settings.as_bool(overlay, "lecture_pipeline_enabled",
                                settings.lecture_pipeline_enabled):
        # 킬 스위치 off — 영상은 pending으로 두고 잡만 done(추측 인제스트 금지).
        await svc.update("jobs", {"id": f"eq.{job['id']}"},
                         {"status": "done", "updated_at": common._now_iso()})
        return

    await svc.update("lecture_videos", {"id": f"eq.{video_id}"},
                     {"status": "parsing", "error": None})
    try:
        html = await lecture_parse.fetch_ebs_html(video["page_url"])
        chapters = lecture_parse.parse_ebs_player(html)
    except Exception as exc:  # noqa: BLE001
        await svc.update("lecture_videos", {"id": f"eq.{video_id}"},
                         {"status": "failed", "error": str(exc)[:500]})
        await jobs._fail_job(svc, job["id"], f"lecture parse error: {exc}")
        return

    if not chapters:
        await svc.update("lecture_videos", {"id": f"eq.{video_id}"},
                         {"status": "failed", "error": "챕터를 찾지 못했습니다"})
        await jobs._fail_job(svc, job["id"], "no chapters")
        return

    # 자막 본문(개정 R1) — 있으면 구간별로 슬라이스, 없으면 빈 본문(제목만 임베딩).
    cues = []
    if video.get("subtitle_path"):
        try:
            data = await svc.storage_download(settings.storage_bucket, video["subtitle_path"])
            cues = subtitle_parse.parse_subtitle(data, video["subtitle_path"])
        except Exception:  # noqa: BLE001 - 자막 실패는 본문만 비운다(파이프라인 계속)
            logger.warning("자막 로드/파싱 실패 video=%s", video_id, exc_info=True)

    # 재파싱 멱등: 기존 클립 제거 후 재삽입. end_sec = 다음 챕터 시작(마지막은 None).
    await svc.delete("lecture_clips", {"video_id": f"eq.{video_id}"})
    clip_rows = []
    for i, ch in enumerate(chapters):
        end_sec = chapters[i + 1].start_sec if i + 1 < len(chapters) else None
        transcript = subtitle_parse.transcript_for(cues, ch.start_sec, end_sec) if cues else ""
        clip_rows.append({
            "video_id": video_id, "seq": i, "start_sec": ch.start_sec, "end_sec": end_sec,
            "title": ch.title, "transcript": transcript, "status": "pending"})
    await svc.insert("lecture_clips", clip_rows, returning=False)
    await svc.update("lecture_videos", {"id": f"eq.{video_id}"}, {"status": "parsed"})

    # lecture_embed 팬아웃(seq 범위).
    n = len(chapters)
    bsize = settings.lecture_batch_size
    for start in range(0, n, bsize):
        await svc.insert("jobs", {
            "owner_id": job.get("owner_id"),
            "kind": "lecture_embed",
            "target_id": video_id,
            "parent_job_id": job["id"],
            "batch_range": {"from_seq": start, "to_seq": min(start + bsize, n)},
            "status": "queued",
        }, returning=False)

    await svc.update("jobs", {"id": f"eq.{job['id']}"},
                     {"status": "done", "updated_at": common._now_iso()})


async def _handle_lecture_embed(svc: Any, job: dict[str, Any]) -> None:
    video_id = job["target_id"]
    rng = job.get("batch_range") or {}
    from_seq, to_seq = int(rng.get("from_seq", 0)), int(rng.get("to_seq", 0))
    overlay = await app_settings.get_overlay()   # 원자 팬아웃 판단용

    clips = await svc.select("lecture_clips", {
        "video_id": f"eq.{video_id}",
        "and": f"(seq.gte.{from_seq},seq.lt.{to_seq})",
        "status": "eq.pending",
        "select": "id,seq,title,transcript", "order": "seq.asc"})
    if not clips:   # 재시도 시 이미 embedded면 스킵(행 단위 멱등)
        await svc.update("jobs", {"id": f"eq.{job['id']}"},
                         {"status": "done", "updated_at": common._now_iso()})
        return

    vids = await svc.select("lecture_videos",
        {"id": f"eq.{video_id}", "select": "id,package_id", "limit": "1"})
    if not vids:
        await jobs._fail_job(svc, job["id"], "lecture video row missing")
        return
    package_id = vids[0]["package_id"]

    # 임베딩 텍스트 = 제목 + 본문(개정 R1). 본문이 비면 제목만.
    def _embed_text(c: dict[str, Any]) -> str:
        t = (c.get("transcript") or "").strip()
        return f"{c['title']}\n\n{t}" if t else c["title"]

    try:
        vectors = await upstage.embed_passages([_embed_text(c) for c in clips])
    except Exception as exc:  # noqa: BLE001
        for c in clips:
            await svc.update("lecture_clips", {"id": f"eq.{c['id']}"}, {"status": "failed"})
        await jobs._fail_job(svc, job["id"], f"lecture embed error: {exc}")
        return
    if len(vectors) != len(clips):
        for c in clips:
            await svc.update("lecture_clips", {"id": f"eq.{c['id']}"}, {"status": "failed"})
        await jobs._fail_job(svc, job["id"], "lecture embedding count mismatch")
        return

    points = [{"id": c["id"], "vector": v, "payload": {
        "clip_id": c["id"], "video_id": str(video_id), "package_id": str(package_id)}}
        for c, v in zip(clips, vectors, strict=True)]
    try:
        await common._qdrant_upsert(points, collection=qdrant_store.COL_LECTURE_CLIPS)
    except Exception as exc:  # noqa: BLE001
        for c in clips:
            await svc.update("lecture_clips", {"id": f"eq.{c['id']}"}, {"status": "failed"})
        await jobs._fail_job(svc, job["id"], f"lecture qdrant error: {exc}")
        return

    sem = asyncio.Semaphore(8)
    async def _mark(cid: str) -> None:
        async with sem:
            await svc.update("lecture_clips", {"id": f"eq.{cid}"}, {"status": "embedded"})
    await asyncio.gather(*(_mark(c["id"]) for c in clips))

    # 원자화 팬아웃(개정 R1) — on일 때만. 같은 seq 범위로 lecture_atom 잡.
    if app_settings.as_bool(overlay, "lecture_atom_enabled", settings.lecture_atom_enabled):
        await svc.insert("jobs", {
            "owner_id": job.get("owner_id"), "kind": "lecture_atom",
            "target_id": video_id, "parent_job_id": job["id"],
            "batch_range": {"from_seq": from_seq, "to_seq": to_seq},
            "status": "queued"}, returning=False)

    await svc.update("jobs", {"id": f"eq.{job['id']}"},
                     {"status": "done", "updated_at": common._now_iso()})
