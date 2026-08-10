"""강의 클립 검색 (D149) — figure_search 미러.

전역 카탈로그는 유저 데이터가 아니라 admin 콘텐츠다. 스코핑은 file_id가 아니라
선생님이 그 워크스페이스에 켠 **package_id**로 한다. 페이로드는 식별자만이므로
히트 후 Postgres에서 클립·영상 행을 재조회해 표시값을 얻는다. 어떤 실패든 [].
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..config import get_settings
from ..db.client import UserClient
from . import app_settings, qdrant_store, upstage

logger = logging.getLogger("nodi.lecture_search")


def fmt_timeline(sec: int) -> str:
    """초 → 사람이 읽는 타임라인. 1시간 미만은 M:SS, 이상은 H:MM:SS.

    EBS 페이지를 파싱하던 모듈에 있던 함수다. 그 모듈은 자동 파싱과 함께
    걷어냈지만(2026-08-10) 이 표시 규칙은 화면이 계속 쓴다.
    """
    sec = max(0, int(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
settings = get_settings()


async def search_class_clips(
    client: UserClient, class_id: str | None, query: str
) -> list[dict[str, Any]]:
    """이중 검색(rag.dual_search D129 미러): 직접(본문) + 원자(질문) → clip_id 병합."""
    if not class_id or not query.strip():
        return []
    try:
        pkg_rows = await client.select("class_lecture_packages",
            {"class_id": f"eq.{class_id}", "select": "package_id"})
        package_ids = [str(r["package_id"]) for r in pkg_rows]
        if not package_ids:
            return []

        overlay = await app_settings.get_overlay()
        top_k = app_settings.as_int(
            overlay, "lecture_retrieve_top_k", settings.lecture_retrieve_top_k, 1, 10
        )
        direct_gate = app_settings.as_float(overlay, "lecture_retrieve_max_distance",
                                            settings.lecture_retrieve_max_distance, 0.1, 0.9)
        atom_on = app_settings.as_bool(
            overlay,
            "lecture_atom_enabled",
            settings.lecture_atom_enabled,
        )
        atom_gate = app_settings.as_float(overlay, "lecture_atom_max_distance",
                                          settings.lecture_atom_max_distance, 0.1, 0.9)
        vec = await upstage.embed_query(query)

        # 동시 검색. 원자 off면 원자 검색은 생략([]).
        async def _atoms() -> list[dict]:
            if not atom_on:
                return []
            return await qdrant_store.search(
                qdrant_store.COL_LECTURE_CLIP_ATOMS, vec, top_k + 3,
                file_ids=package_ids, scope_field="package_id")   # 게이트는 아래서 수동 적용
        direct_hits, atom_hits = await asyncio.gather(
            qdrant_store.search(qdrant_store.COL_LECTURE_CLIPS, vec, top_k,
                                file_ids=package_ids, scope_field="package_id",
                                score_threshold=1.0 - direct_gate),
            _atoms())

        # 직접 히트: point id = clip id. 랭킹 순.
        order: list[tuple[str, str, float]] = []   # (clip_id, via, dist_key)
        direct_ids: set[str] = set()
        for h in direct_hits:
            cid = str(h["id"])
            if cid in direct_ids:
                continue
            direct_ids.add(cid)
            order.append((cid, "clip", 1.0 - float(h["score"])))
        # 원자 히트: payload.clip_id로 역참조, 게이트 적용, 직접에 있으면 제외, clip별 최소 거리.
        atom_best: dict[str, float] = {}
        for h in atom_hits:
            src = (h.get("payload") or {}).get("clip_id")
            if not src:
                continue
            src = str(src)
            adist = 1.0 - float(h["score"])
            if adist > atom_gate or src in direct_ids:
                continue
            if src not in atom_best or adist < atom_best[src]:
                atom_best[src] = adist
        for cid, adist in sorted(atom_best.items(), key=lambda kv: kv[1]):
            order.append((cid, "atom", adist))

        order = order[: top_k + 3]
        if not order:
            return []

        clip_ids = [cid for cid, _, _ in order]
        clip_rows = await client.select("lecture_clips",
            {"id": f"in.({','.join(clip_ids)})", "select": "id,video_id,start_sec,title"})
        by_id = {str(r["id"]): r for r in clip_rows}
        video_ids = {str(r["video_id"]) for r in clip_rows}
        v_rows = (await client.select("lecture_videos",
            {"id": f"in.({','.join(video_ids)})", "select": "id,page_url,title"})
            if video_ids else [])
        vmap = {str(v["id"]): v for v in v_rows}

        out: list[dict[str, Any]] = []
        for cid, via, dist in order:
            r = by_id.get(cid)
            if not r:
                continue                     # RLS 재조회 못한 히트 탈락
            v = vmap.get(str(r["video_id"])) or {}
            sec = int(r.get("start_sec") or 0)
            out.append({
                "clip_id": cid,
                "title": r.get("title") or "",
                "start_sec": sec,
                "timeline_label": fmt_timeline(sec),
                "page_url": v.get("page_url") or "",
                "video_title": v.get("title") or "",
                "via": via,
                "score": 1.0 - dist,
            })
        logger.info("강의 클립 검색: %d건(직접 %d)", len(out), len(direct_ids))
        return out
    except Exception:  # noqa: BLE001 - 검색 실패는 빈 목록으로 강등
        logger.exception("강의 클립 검색 실패 — 빈 목록으로 진행")
        return []
