"""강의 클립 인제스트 워커 (D149, 2026-08-10 개정).

lecture_embed: 클립 제목+본문 embedding-passage → Qdrant lecture_clips → 행 embedded.
lecture_atom: 클립당 예상 질문 생성 → Qdrant lecture_clip_atoms.

⚠️ **`lecture_parse` 잡은 없다.** 예전에는 서버가 EBS 페이지를 가져와 챕터를
파싱하고, 자막이 없으면 Whisper로 전사까지 했다. 대회 규정상 제품 안에서
해외 모델을 쓸 수 없어 그 경로를 통째로 걷어냈다(2026-08-10) — 파싱과 전사는
저장소 밖 오프라인 스크립트(`.claude/scripts/parse_lectures.py`)가 하고,
관리자는 그 결과 파일을 끌어다 놓는다. 그때 클립 행이 바로 만들어지고
여기서는 임베딩부터 시작한다.

실패는 lecture_videos/lecture_clips.status로 격리 — files.status 절대 안 건드림(D88 동형).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from ...config import get_settings
from .. import (
    app_settings,
    atomize,
    qdrant_store,
    solar,
    upstage,
)
from . import common, jobs

logger = logging.getLogger("nodi.worker.lectures")
settings = get_settings()


# 회로차단 임계 — solar가 연속 이만큼 실패하면 잔여 클립 생성을 생략하고 배치를
# 실패 처리한다(atoms.CIRCUIT_BREAK_THRESHOLD와 동형). 죽은 엔드포인트에서 클립마다
# 재시도가 누적돼 잡이 무한정 길어지는 사고를 막는다.
_ATOM_CIRCUIT_BREAK = 5


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


async def _handle_lecture_atom(svc: Any, job: dict[str, Any]) -> None:
    """embedded 클립의 제목+본문에서 solar-pro3로 예상 질문을 생성→임베딩→Qdrant
    적재(D149, PIKE-RAG D129 동형). atoms._handle_atom_batch를 미러한다.

    실패 격리(D88): 원자 실패는 클립·영상·files.status를 절대 건드리지 않는다 —
    핸들러가 만지는 상태는 lecture_clip_atoms.status와 잡 상태뿐이다. 연속
    _ATOM_CIRCUIT_BREAK회 생성 실패면 회로차단·배치 실패(attempts 재시도 상속).
    Qdrant 페이로드는 식별자만(질문 본문 금지 — Qdrant 신뢰 경계 아님 불변식).
    """
    video_id = job["target_id"]
    rng = job.get("batch_range") or {}
    from_seq, to_seq = int(rng.get("from_seq", 0)), int(rng.get("to_seq", 0))
    overlay = await app_settings.get_overlay()
    if not app_settings.as_bool(overlay, "lecture_atom_enabled", settings.lecture_atom_enabled):
        # 킬 스위치 off — 팬아웃 후 꺼졌으면 solar 없이 조용히 마감.
        await svc.update("jobs", {"id": f"eq.{job['id']}"},
                         {"status": "done", "updated_at": common._now_iso()})
        return

    clips = await svc.select("lecture_clips", {
        "video_id": f"eq.{video_id}",
        "and": f"(seq.gte.{from_seq},seq.lt.{to_seq})",
        "status": "eq.embedded",
        "select": "id,seq,title,transcript", "order": "seq.asc"})
    clips = [c for c in clips if (c.get("transcript") or "").strip()]   # 본문 있는 것만
    if not clips:
        await svc.update("jobs", {"id": f"eq.{job['id']}"},
                         {"status": "done", "updated_at": common._now_iso()})
        return

    # 멱등: 이 클립들의 기존 원자(행+Qdrant 포인트) 제거 후 재생성.
    clip_ids = [str(c["id"]) for c in clips]
    old = await svc.select("lecture_clip_atoms",
        {"clip_id": f"in.({','.join(clip_ids)})", "select": "id"})
    if old:
        await common._qdrant_delete_points([str(o["id"]) for o in old],
                                           collection=qdrant_store.COL_LECTURE_CLIP_ATOMS)
        await svc.delete("lecture_clip_atoms", {"clip_id": f"in.({','.join(clip_ids)})"})

    vids = await svc.select("lecture_videos",
        {"id": f"eq.{video_id}", "select": "id,package_id", "limit": "1"})
    if not vids:
        await jobs._fail_job(svc, job["id"], "lecture video row missing")
        return
    package_id = vids[0]["package_id"]

    n = app_settings.as_int(
        overlay,
        "lecture_atoms_per_clip",
        settings.lecture_atoms_per_clip,
        1,
        8,
    )
    concurrency = app_settings.as_int(
        overlay,
        "lecture_atom_concurrency",
        settings.lecture_atom_concurrency,
        1,
        16,
    )
    sem = asyncio.Semaphore(max(1, concurrency))
    # 회로차단 상태 — 세마포어로 직렬화된 임계 구간에서만 갱신(락 불필요, atoms.py 동형).
    state = {"consecutive": 0, "broken": False}

    async def _gen(clip: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        async with sem:
            if state["broken"]:
                return clip, []  # 회로 개방 — 잔여 클립 생성 생략
            try:
                text = f"{clip['title']}\n\n{clip['transcript']}"
                comp = await solar.complete(
                    atomize.build_atom_messages(text, n),
                    max_tokens=256, model=settings.lecture_atom_model)  # solar-pro3
                qs = atomize.parse_atom_questions((comp.message or {}).get("content") or "", n)
                state["consecutive"] = 0
                await common.touch_job(svc, job["id"])   # 하트비트 — 스테일 복구 오탐 방지(D120)
                return clip, qs
            except Exception:  # noqa: BLE001 - 개별 실패는 그 클립만 건너뜀
                state["consecutive"] += 1
                if state["consecutive"] >= _ATOM_CIRCUIT_BREAK:
                    state["broken"] = True
                return clip, []

    results = await asyncio.gather(*(_gen(c) for c in clips))
    if state["broken"]:
        await jobs._fail_job(svc, job["id"], "lecture atom circuit break")
        return

    rows = [{"clip_id": clip["id"], "package_id": str(package_id),
             "question": q, "status": "pending"}
            for clip, qs in results for q in qs]
    if not rows:
        await svc.update("jobs", {"id": f"eq.{job['id']}"},
                         {"status": "done", "updated_at": common._now_iso()})
        return

    inserted = await svc.insert("lecture_clip_atoms", rows, returning=True)
    try:
        vectors = await upstage.embed_passages([r["question"] for r in inserted])
    except Exception as exc:  # noqa: BLE001
        for r in inserted:
            await svc.update("lecture_clip_atoms", {"id": f"eq.{r['id']}"}, {"status": "failed"})
        await jobs._fail_job(svc, job["id"], f"lecture atom embed error: {exc}")
        return
    if len(vectors) != len(inserted):
        for r in inserted:
            await svc.update("lecture_clip_atoms", {"id": f"eq.{r['id']}"}, {"status": "failed"})
        await jobs._fail_job(svc, job["id"], "lecture atom embedding count mismatch")
        return

    points = [{"id": r["id"], "vector": v, "payload": {
        "atom_id": r["id"], "clip_id": str(r["clip_id"]), "package_id": str(package_id)}}
        for r, v in zip(inserted, vectors, strict=True)]
    try:
        await common._qdrant_upsert(points, collection=qdrant_store.COL_LECTURE_CLIP_ATOMS)
    except Exception as exc:  # noqa: BLE001
        for r in inserted:
            await svc.update("lecture_clip_atoms", {"id": f"eq.{r['id']}"}, {"status": "failed"})
        await jobs._fail_job(svc, job["id"], f"lecture atom qdrant error: {exc}")
        return

    sem2 = asyncio.Semaphore(8)

    async def _mark(aid: str) -> None:
        async with sem2:
            await svc.update("lecture_clip_atoms", {"id": f"eq.{aid}"}, {"status": "embedded"})
    await asyncio.gather(*(_mark(r["id"]) for r in inserted))

    # D88 격리: files.status·lecture_videos.status 절대 안 건드림(원자 실패는 클립과 독립).
    await svc.update("jobs", {"id": f"eq.{job['id']}"},
                     {"status": "done", "updated_at": common._now_iso()})
