"""교차 세션 개념 연결 잡 (D171).

카드 하나에 대해 **색인 → 교차 검색 → 설명 → 링크 저장**을 한 번에 한다.
잡을 둘로 쪼개지 않는 이유: 색인과 검색이 같은 카드에 대한 연속 동작이고,
쪼개면 "색인은 됐는데 검색 잡이 유실된" 반쪽 상태가 생긴다.

어떤 실패든 링크를 만들지 않고 잡은 done으로 닫는다. 이 기능은 채팅을 막지
않고(불변식), 없어도 학습에 지장이 없다 — 재시도로 워커를 붙잡아 둘 이유가
없다.
"""
from __future__ import annotations

import logging
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
            "select": "id,owner_id,space_kind,space_ref",
            "limit": "1",
        },
    )
    return rows[0] if rows else None


async def _handle_crosslink(svc: Any, job: dict[str, Any]) -> None:
    item_id = job["target_id"]

    knobs = await crosslink.read_knobs()
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

    # 1) 색인. 실패하면 검색도 의미가 없다(자기 벡터가 없으면 질의도 못 만든다).
    try:
        indexed = await crosslink.index_item(item, session)
    except Exception:  # noqa: BLE001
        logger.warning("개념 카드 색인 실패 item=%s", item_id, exc_info=True)
        await _done(svc, job["id"])
        return
    if not indexed:
        await _done(svc, job["id"])
        return

    # 2) 교차 검색. 임베딩은 **비대칭**이라 질의는 embedding-query로 다시 만든다
    #    (불변식 — passage 벡터를 질의로 재사용하면 안 된다).
    try:
        hits = await qdrant_store.search_concepts(
            await upstage.embed_query(crosslink.embed_text(item)),
            knobs["top_k"],
            owner_id=str(session["owner_id"]),
            exclude_session_id=str(item["session_id"]),
            exclude_tag_norm=crosslink.norm_tag(item.get("tag")),
            allowed_space_kinds=crosslink.allowed_space_kinds(
                str(session.get("space_kind") or "personal")
            ),
        )
    except Exception:  # noqa: BLE001
        logger.warning("교차 검색 실패 item=%s", item_id, exc_info=True)
        await _done(svc, job["id"])
        return

    # 3) 띠를 통과하는 첫 히트 하나만 쓴다(카드당 링크 1개 — 사용자 결정).
    #    이미 이 카드에 링크가 있으면 아무것도 하지 않는다.
    existing = await svc.select(
        "item_links", {"from_item_id": f"eq.{item_id}", "select": "id", "limit": "1"}
    )
    if existing:
        await _done(svc, job["id"])
        return

    for hit in hits:
        distance = 1.0 - float(hit.get("score") or 0.0)  # 거리 규약(불변식)
        if not crosslink.in_band(distance, knobs["lo"], knobs["hi"]):
            continue
        past_id = str((hit.get("payload") or {}).get("item_id") or "")
        if not past_id or past_id == str(item_id):
            continue
        past = await _load_item(svc, past_id)
        if past is None:
            # Qdrant에 남은 유령 포인트 — 카드가 지워졌다. 정리하고 넘어간다.
            continue

        text = await crosslink.explain(item, past)
        if not text:
            # 모델이 "관련 없음"이라고 했거나 생성이 실패했다. **억지로 잇지
            # 않는다** — 잘못된 연결은 없는 것보다 나쁘다. 다음 히트로 넘어간다.
            continue

        await svc.insert(
            "item_links",
            {
                "owner_id": str(session["owner_id"]),
                "from_item_id": str(item_id),
                "to_item_id": past_id,
                "explanation": text,
                "distance": distance,
            },
            returning=False,
        )
        logger.info(
            "교차 연결 생성 item=%s → %s (거리 %.3f)", item_id, past_id, distance
        )
        break

    await _done(svc, job["id"])
