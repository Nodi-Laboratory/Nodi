"""교차 세션 개념 연결 조회·표시 (D171).

**히트 후 본문은 언제나 여기서 다시 읽는다.** Qdrant 페이로드에는 식별자만
들어 있고(불변식), 실제 권한 판정은 이 조회의 RLS가 한다. 워커가 만든 링크라도
학생이 볼 수 있는지는 여기서 결정된다.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status

from ..db.client import UserClient

logger = logging.getLogger("nodi.item_links")

# 한 세션의 링크 상한. 카드당 1개(사용자 결정)라 세션 카드 수만큼이 최대인데,
# 조회를 무한정 키우지 않는다.
_MAX_LINKS = 200


async def list_links(
    client: UserClient, session_id: str
) -> list[dict[str, Any]]:
    """이 세션 카드들에 붙은 연결 목록.

    "돌아가기"에 필요한 것을 **한 번에** 다 실어 보낸다 — 목적지 세션의
    `space_kind`·`space_ref`까지. 세션은 공간에 속하므로(D148) 둘 중 하나만
    주면 프론트가 학급 공간에서 개인 세션을 여는 사고를 낼 수 있다.
    """
    items = await client.select(
        "canvas_items", {"session_id": f"eq.{session_id}", "select": "id"}
    )
    ids = [str(r["id"]) for r in items]
    if not ids:
        return []

    links = await client.select(
        "item_links",
        {
            "from_item_id": f"in.({','.join(ids)})",
            "select": "id,from_item_id,to_item_id,explanation,distance,opened_at",
            "order": "created_at.desc",
            "limit": str(_MAX_LINKS),
        },
    )
    if not links:
        return []

    # 목적지 카드 — RLS가 여기서 한 번 더 본다.
    to_ids = sorted({str(r["to_item_id"]) for r in links})
    past = await client.select(
        "canvas_items",
        {
            "id": f"in.({','.join(to_ids)})",
            "select": "id,session_id,title,tag",
        },
    )
    past_by_id = {str(r["id"]): r for r in past}

    sess_ids = sorted({str(r["session_id"]) for r in past})
    sessions = (
        await client.select(
            "sessions",
            {
                "id": f"in.({','.join(sess_ids)})",
                "select": "id,title,space_kind,space_ref",
            },
        )
        if sess_ids
        else []
    )
    sess_by_id = {str(r["id"]): r for r in sessions}

    out: list[dict[str, Any]] = []
    for link in links:
        tgt = past_by_id.get(str(link["to_item_id"]))
        if tgt is None:
            # 목적지 카드가 지워졌거나 RLS로 안 보인다 — 갈 수 없는 링크는
            # 아예 내려보내지 않는다. 눌렀는데 아무 일도 안 나는 버튼은
            # 고장으로 읽힌다.
            continue
        sess = sess_by_id.get(str(tgt["session_id"]))
        if sess is None:
            continue
        out.append(
            {
                "id": str(link["id"]),
                "from_item_id": str(link["from_item_id"]),
                "explanation": link.get("explanation") or "",
                "distance": link.get("distance"),
                "opened_at": link.get("opened_at"),
                "to": {
                    "item_id": str(tgt["id"]),
                    "session_id": str(tgt["session_id"]),
                    "session_title": sess.get("title"),
                    "space_kind": sess.get("space_kind"),
                    "space_ref": (
                        str(sess["space_ref"]) if sess.get("space_ref") else None
                    ),
                    "title": tgt.get("title"),
                    "tag": tgt.get("tag"),
                },
            }
        )
    return out


async def mark_opened(client: UserClient, link_id: str) -> dict[str, Any]:
    """열어 본 표식. 깜빡임을 멈추는 유일한 방법이다.

    **멱등이다** — 이미 열린 링크를 다시 눌러도 시각을 덮어쓰지 않는다.
    처음 본 때가 의미 있는 값이지 마지막으로 본 때가 아니다.
    """
    rows = await client.select(
        "item_links", {"id": f"eq.{link_id}", "select": "id,opened_at", "limit": "1"}
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="연결을 찾을 수 없습니다."
        )
    if rows[0].get("opened_at"):
        return {"id": str(rows[0]["id"]), "opened_at": rows[0]["opened_at"]}

    # 값은 ISO 문자열로 보낸다 — `_fetch`가 서버 선언 타입(timestamptz)을 보고
    # 변환한다(D112: 형태만 보고 승격하던 옛 경로는 제거됐다).
    updated = await client.update(
        "item_links",
        {"id": f"eq.{link_id}"},
        {"opened_at": datetime.now(UTC).isoformat()},
    )
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="연결을 찾을 수 없습니다."
        )
    return {"id": str(updated[0]["id"]), "opened_at": updated[0].get("opened_at")}
