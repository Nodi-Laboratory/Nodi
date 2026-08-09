"""세션 선택 화면의 **대화방 목록** (사용자 지시 2026-08-09).

공간 카드를 누르면 그 안의 대화방이 뜨고, 화면 아래에는 **공간 상관없이**
최근에 이야기한 방이 뜬다. 둘 다 방 이름 옆에 그 방에서 다룬 **개념**이
색 칩으로 붙는다 — 제목이 "제목 없는 대화"인 방이 수두룩해서, 이름만으로는
어느 방인지 고를 수가 없다.

## 개념은 **많이 이야기한 순**이다

`spaces_overview`와 같은 규칙이다(그쪽은 공간 단위, 여기는 방 단위). 방금
스친 개념이 아니라 오래 붙들고 있던 개념이 그 방을 대표한다.

## 세는 것은 요약이지 통계가 아니다

방이 수백 개인 공간이 있고(실측: 개발 DB의 개인 공간에 357개), 방마다 카드를
다 읽으면 이 화면이 대화보다 무거워진다. **한 번에 훑는 카드 수**(`_SCAN`)를
못 박고, 목록도 `_ROOMS` 개까지만 준다. 화면도 그렇게 쓴다 — 넘치면 `…`다.
"""

from __future__ import annotations

import logging
from typing import Any

from ..db.client import UserClient
from . import home

logger = logging.getLogger("nodi.space_rooms")

#: 한 번에 훑는 개념 카드 수 상한. 방 하나가 아니라 **요청 하나**의 상한이다.
_SCAN = 1200

#: 한 공간에서 돌려주는 대화방 수 상한.
_ROOMS = 60

#: 방 하나에 붙이는 개념 수 상한. 화면은 폭에 맞춰 더 줄이고 넘치면 `…`다.
_TOP_CONCEPTS = 8

#: 아래 상자("최근 대화")가 돌려주는 방 수.
_RECENT = 12


async def _concepts_by_session(
    client: UserClient, session_ids: list[str]
) -> dict[str, list[str]]:
    """방마다 **많이 이야기한 순** 분류 이름.

    한 번의 질의로 끝낸다 — 방마다 물으면 방 60개에 왕복 60번이다.
    """
    if not session_ids:
        return {}
    rows = await client.select(
        "canvas_items",
        {
            "session_id": f"in.({','.join(session_ids)})",
            "kind": "eq.concept",
            "source": "eq.ai",
            "select": "session_id,tag",
            "order": "created_at.desc",
            "limit": str(_SCAN),
        },
    )
    counts: dict[str, dict[str, int]] = {}
    for r in rows:
        tag = (r.get("tag") or "").strip()
        if not tag:
            continue
        sid = str(r["session_id"])
        counts.setdefault(sid, {})
        counts[sid][tag] = counts[sid].get(tag, 0) + 1
    return {
        sid: [t for t, _ in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))[:_TOP_CONCEPTS]]
        for sid, c in counts.items()
    }


def _row(
    s: dict[str, Any],
    concepts: list[str],
    space_name: str | None = None,
    me: str | None = None,
) -> dict[str, Any]:
    return {
        "id": str(s["id"]),
        "title": s.get("title") or "",
        "updated_at": s.get("updated_at"),
        "space_kind": s.get("space_kind"),
        "space_ref": str(s.get("space_ref")),
        "space_name": space_name,
        "concepts": concepts,
        # **내 방인가.** 선생님은 학급의 학생 방까지 볼 수 있어서(RLS
        # `sessions_select`) 목록에 남의 방이 섞인다. 이름 변경·삭제는 주인만
        # 되므로(RLS), 화면이 그 구분을 알아야 **할 수 없는 일을 권하지 않는다**.
        "is_mine": str(s.get("owner_id") or "") == str(me or ""),
    }


async def rooms(
    client: UserClient, user_id: str, space_kind: str, space_ref: str | None
) -> list[dict[str, Any]]:
    """한 공간의 대화방 목록(최근 순) + 방마다의 개념."""
    # 개인 공간의 `space_ref`는 자기 자신이다(`sessions.create_session`과 같다).
    ref = space_ref or (user_id if space_kind == "personal" else None)
    if not ref:
        return []
    sessions = await client.select(
        "sessions",
        {
            "space_kind": f"eq.{space_kind}",
            "space_ref": f"eq.{ref}",
            "select": "id,title,updated_at,space_kind,space_ref,owner_id",
            "order": "updated_at.desc",
            "limit": str(_ROOMS),
        },
    )
    concepts: dict[str, list[str]] = {}
    try:
        concepts = await _concepts_by_session(client, [str(s["id"]) for s in sessions])
    except Exception:  # noqa: BLE001 - 칩이 없다고 목록을 막지 않는다
        logger.warning("방별 개념 집계 실패: %s/%s", space_kind, ref, exc_info=True)
    return [_row(s, concepts.get(str(s["id"]), []), me=user_id) for s in sessions]


async def recent(client: UserClient, user_id: str) -> list[dict[str, Any]]:
    """**공간 상관없이** 최근에 이야기한 방.

    학생이 실제로 하는 일은 "어제 하던 그 대화 이어 하기"인데, 그러려면 지금은
    공간을 먼저 고르고 그 안에서 다시 찾아야 한다. 이 목록이 그 두 단계를
    건너뛴다 — 그래서 **어느 공간의 방인지**도 함께 준다.
    """
    spaces = await home.get_my_spaces(client, user_id)
    if not spaces:
        return []
    names = {str(s["space_ref"]): s.get("name") for s in spaces}
    refs = [str(s["space_ref"]) for s in spaces]
    sessions = await client.select(
        "sessions",
        {
            "space_ref": f"in.({','.join(refs)})",
            "select": "id,title,updated_at,space_kind,space_ref,owner_id",
            "order": "updated_at.desc",
            "limit": str(_RECENT),
        },
    )
    concepts: dict[str, list[str]] = {}
    try:
        concepts = await _concepts_by_session(client, [str(s["id"]) for s in sessions])
    except Exception:  # noqa: BLE001
        logger.warning("최근 방 개념 집계 실패", exc_info=True)
    return [
        _row(
            s,
            concepts.get(str(s["id"]), []),
            # 개인 공간의 이름은 사람 이름이 아니라 **"개인 세션"**이어야 한다 —
            # 화면에서 학급 이름과 나란히 서기 때문이다.
            "개인 세션"
            if s.get("space_kind") == "personal"
            else names.get(str(s.get("space_ref"))),
            me=user_id,
        )
        for s in sessions
    ]
