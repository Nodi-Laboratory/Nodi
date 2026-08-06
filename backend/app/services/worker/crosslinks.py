"""교차 세션 개념 연결 잡 (D171) + 판정 로그 (D172).

카드 하나에 대해 **색인 → 교차 검색 → 설명 → 링크 저장**을 한 번에 한다.
잡을 둘로 쪼개지 않는 이유: 색인과 검색이 같은 카드에 대한 연속 동작이고,
쪼개면 "색인은 됐는데 검색 잡이 유실된" 반쪽 상태가 생긴다.

어떤 실패든 링크를 만들지 않고 잡은 done으로 닫는다. 이 기능은 채팅을 막지
않고(불변식), 없어도 학습에 지장이 없다 — 재시도로 워커를 붙잡아 둘 이유가
없다.

**판정은 언제나 남긴다** (D172). 링크가 안 생긴 이유를 볼 수 없으면
"왜 안 뜨지"에 답할 방법이 없다 — 거리가 멀어서인지, 같은 태그라서인지,
모델이 관련 없다고 했는지 구분이 안 된다.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from ...services import crosslink, qdrant_store, upstage
from . import common

logger = logging.getLogger("nodi.worker.crosslink")


async def _done(svc: Any, job_id: str) -> None:
    await svc.update(
        "jobs", {"id": f"eq.{job_id}"},
        {"status": "done", "updated_at": common._now_iso()},
    )


async def _load_item(svc: Any, item_id: str) -> dict[str, Any] | None:
    rows = await svc.select(
        "canvas_items",
        {
            "id": f"eq.{item_id}",
            "select": "id,session_id,kind,source,title,body,tag",
            "limit": "1",
        },
    )
    return rows[0] if rows else None


async def _load_session(svc: Any, session_id: str) -> dict[str, Any] | None:
    rows = await svc.select(
        "sessions",
        {
            "id": f"eq.{session_id}",
            "select": "id,owner_id,space_kind,space_ref,title",
            "limit": "1",
        },
    )
    return rows[0] if rows else None


async def _log_run(svc: Any, row: dict[str, Any]) -> None:
    """판정 기록. **실패해도 잡을 죽이지 않는다** — 로그가 본 작업을 막으면 안 된다."""
    try:
        await svc.insert("crosslink_runs", row, returning=False)
    except Exception:  # noqa: BLE001
        logger.warning("교차 연결 판정 로그 기록 실패", exc_info=True)


async def _handle_crosslink(svc: Any, job: dict[str, Any]) -> None:
    started = time.monotonic()
    item_id = job["target_id"]

    knobs = await crosslink.read_knobs()
    base: dict[str, Any] = {
        "from_item_id": item_id,
        "knobs": knobs,
        "candidates": [],
        "searched_sessions": 0,
    }

    def elapsed() -> int:
        return int((time.monotonic() - started) * 1000)

    if not knobs["enabled"]:
        # 킬 스위치 off — 색인도 하지 않는다. 나중에 켜면 백필로 채운다.
        await _done(svc, job["id"])
        return

    item = await _load_item(svc, item_id)
    if item is None:
        # 카드가 지워졌다 — 정상적인 경합이다(학생이 바로 지울 수 있다).
        await _done(svc, job["id"])
        return
    session = await _load_session(svc, str(item["session_id"]))
    if session is None:
        await _done(svc, job["id"])
        return

    owner_id = str(session["owner_id"])
    base.update({
        "owner_id": owner_id,
        "from_session_id": str(item["session_id"]),
        "from_title": item.get("title"),
        "from_tag": item.get("tag"),
        "from_space_kind": session.get("space_kind"),
    })

    # 1) 색인. 실패하면 검색도 의미가 없다(자기 벡터가 없으면 질의도 못 만든다).
    try:
        indexed = await crosslink.index_item(item, session)
    except Exception:  # noqa: BLE001
        logger.warning("개념 카드 색인 실패 item=%s", item_id, exc_info=True)
        await _log_run(svc, {**base, "outcome": "skipped",
                             "explanation": "색인 실패", "duration_ms": elapsed()})
        await _done(svc, job["id"])
        return
    if not indexed:
        await _log_run(svc, {**base, "outcome": "skipped",
                             "explanation": "본문이 비어 색인하지 않음",
                             "duration_ms": elapsed()})
        await _done(svc, job["id"])
        return

    # 2) 교차 검색. 임베딩은 **비대칭**이라 질의는 embedding-query로 다시 만든다
    #    (불변식 — passage 벡터를 질의로 재사용하면 안 된다).
    try:
        hits = await qdrant_store.search_concepts(
            await upstage.embed_query(crosslink.embed_text(item)),
            knobs["top_k"],
            owner_id=owner_id,
            exclude_session_id=str(item["session_id"]),
            exclude_tag_norm=crosslink.norm_tag(item.get("tag")),
            allowed_space_kinds=crosslink.allowed_space_kinds(
                str(session.get("space_kind") or "personal")
            ),
        )
    except Exception:  # noqa: BLE001
        logger.warning("교차 검색 실패 item=%s", item_id, exc_info=True)
        await _log_run(svc, {**base, "outcome": "skipped",
                             "explanation": "검색 실패", "duration_ms": elapsed()})
        await _done(svc, job["id"])
        return

    # 이미 이 카드에 링크가 있으면 아무것도 하지 않는다(카드당 1개 — 사용자 결정).
    existing = await svc.select(
        "item_links", {"from_item_id": f"eq.{item_id}", "select": "id", "limit": "1"}
    )
    if existing:
        await _log_run(svc, {**base, "outcome": "skipped",
                             "explanation": "이미 링크가 있음",
                             "duration_ms": elapsed()})
        await _done(svc, job["id"])
        return

    # 3) 후보를 하나씩 판정한다. **떨어진 것도 전부 기록한다** (D172).
    cands: list[dict[str, Any]] = []
    sessions_seen: set[str] = set()
    link_id: str | None = None
    explanation = ""

    for hit in hits:
        distance = 1.0 - float(hit.get("score") or 0.0)  # 거리 규약(불변식)
        payload = hit.get("payload") or {}
        past_id = str(payload.get("item_id") or "")
        sess_id = str(payload.get("session_id") or "")
        if sess_id:
            sessions_seen.add(sess_id)

        cand: dict[str, Any] = {
            "item_id": past_id,
            "session_id": sess_id,
            "tag": payload.get("tag_norm"),
            "space_kind": payload.get("space_kind"),
            "distance": round(distance, 4),
        }

        if not past_id or past_id == str(item_id):
            cand.update(verdict="vanished", reason="자기 자신이거나 id가 없음")
            cands.append(cand)
            continue

        # 상시 켜기(D172)면 띠를 건너뛴다 — 테스트용.
        verdict, reason = crosslink.band_verdict(
            distance, knobs["lo"], knobs["hi"], knobs["always_on"]
        )
        if verdict != "accepted":
            cand.update(verdict=verdict, reason=reason)
            cands.append(cand)
            continue

        past = await _load_item(svc, past_id)
        if past is None:
            # Qdrant에 남은 유령 포인트 — 카드가 지워졌다.
            cand.update(verdict="vanished", reason="과거 카드가 지워짐")
            cands.append(cand)
            continue

        past_sess = await _load_session(svc, str(past["session_id"]))
        cand["session_title"] = (past_sess or {}).get("title")
        cand["title"] = past.get("title")

        text = await crosslink.explain(item, past, knobs.get("model"))
        if not text:
            # 모델이 "관련 없음"이라고 했거나 생성이 실패했다. **억지로 잇지
            # 않는다** — 잘못된 연결은 없는 것보다 나쁘다.
            cand.update(
                verdict="no_explanation",
                reason="모델이 관련 없다고 했거나 생성 실패",
            )
            cands.append(cand)
            continue

        created = await svc.insert(
            "item_links",
            {
                "owner_id": owner_id,
                "from_item_id": str(item_id),
                "to_item_id": past_id,
                "explanation": text,
                "distance": distance,
            },
        )
        row = created[0] if isinstance(created, list) else created
        link_id = str((row or {}).get("id") or "") or None
        explanation = text
        cand.update(verdict="accepted", reason="링크 생성")
        cands.append(cand)
        logger.info(
            "교차 연결 생성 item=%s → %s (거리 %.3f)", item_id, past_id, distance
        )
        break

    outcome = (
        "linked" if link_id
        else ("no_candidate" if not cands else "all_rejected")
    )
    await _log_run(svc, {
        **base,
        "candidates": cands,
        "searched_sessions": len(sessions_seen),
        "outcome": outcome,
        "link_id": link_id,
        "explanation": explanation,
        "duration_ms": elapsed(),
    })
    await _done(svc, job["id"])
