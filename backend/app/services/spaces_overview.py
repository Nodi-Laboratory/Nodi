"""세션 선택 화면이 쓰는 공간 요약 (사용자 지시 2026-08-09).

## 이 화면이 답해야 하는 것

학생이 "어디로 들어갈까"를 정하는 화면이다. 그 판단에 필요한 것은 셋이다 —
**어느 학급인지**(사진), **뭘 가지고 있는지**(자료·강의 수), **거기서 무슨
얘기를 했는지**(개념). 이름만 나열하면 학급이 늘었을 때 고를 수가 없다.

## 개념은 **많이 이야기한 순**이다

최신순이 아니다. 그 공간을 대표하는 것은 방금 스친 개념이 아니라 **오래
붙들고 있던 개념**이고, 그것이 카드 수로 드러난다(한 개념을 파고들수록 그
분류의 카드가 는다).

## 한 화면에 담을 만큼만 센다

카드가 수천 장인 공간도 있다(실측: 개발 DB에 2,298장). 전부 읽어 세면 이
화면이 대화보다 무거워진다 — 공간마다 최근 `_CARD_SCAN`장까지만 본다.
그래서 이 숫자는 **정확한 통계가 아니라 요약**이다. 화면도 그렇게 쓴다.
"""

from __future__ import annotations

import logging
from typing import Any

from ..db.client import UserClient
from . import home

logger = logging.getLogger("nodi.spaces_overview")

#: 공간마다 개념을 셀 때 훑는 카드 수 상한.
_CARD_SCAN = 600

#: 한 공간에서 돌려주는 개념 수 상한. 화면은 상자 크기에 맞춰 더 줄이고
#: 넘치면 `…`로 접는다 — 여기서는 그 재료만 넉넉히 준다.
_TOP_CONCEPTS = 12

#: 학급 자료로 세는 파일 종류. 학생이 자기 세션에 붙인 파일(`user_upload`)은
#: 그 공간의 자료가 아니라 그 대화의 자료라서 뺀다.
_MATERIAL_KINDS = ("class_material", "textbook")


async def _session_ids(client: UserClient, space_kind: str, ref: str) -> list[str]:
    rows = await client.select(
        "sessions",
        {
            "space_kind": f"eq.{space_kind}",
            "space_ref": f"eq.{ref}",
            "select": "id",
            "order": "updated_at.desc",
        },
    )
    return [str(r["id"]) for r in rows]


async def _top_concepts(client: UserClient, session_ids: list[str]) -> list[str]:
    """이 공간에서 **많이 이야기한 순** 분류 이름."""
    if not session_ids:
        return []
    rows = await client.select(
        "canvas_items",
        {
            "session_id": f"in.({','.join(session_ids)})",
            "kind": "eq.concept",
            "source": "eq.ai",
            "select": "tag",
            "order": "created_at.desc",
            "limit": str(_CARD_SCAN),
        },
    )
    counts: dict[str, int] = {}
    for r in rows:
        tag = (r.get("tag") or "").strip()
        if tag:
            counts[tag] = counts.get(tag, 0) + 1
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [t for t, _ in ordered[:_TOP_CONCEPTS]]


async def _class_counts(client: UserClient, class_id: str) -> tuple[int, int]:
    """(자료 수, 연결된 강의 수)."""
    materials = 0
    try:
        materials = await client.count(
            "files",
            {
                "space_kind": "eq.class",
                "space_ref": f"eq.{class_id}",
                "kind": f"in.({','.join(_MATERIAL_KINDS)})",
            },
        )
    except Exception:  # noqa: BLE001 - 요약이 화면을 막지 않는다
        logger.warning("학급 자료 수 조회 실패: %s", class_id, exc_info=True)

    lectures = 0
    try:
        pkgs = await client.select(
            "class_lecture_packages",
            {"class_id": f"eq.{class_id}", "select": "package_id"},
        )
        ids = [str(r["package_id"]) for r in pkgs]
        if ids:
            lectures = await client.count(
                "lecture_videos", {"package_id": f"in.({','.join(ids)})"}
            )
    except Exception:  # noqa: BLE001
        logger.warning("학급 강의 수 조회 실패: %s", class_id, exc_info=True)
    return materials, lectures


async def overview(client: UserClient, user_id: str) -> list[dict[str, Any]]:
    """세션 선택 화면용 공간 목록.

    **개인 공간이 언제나 첫 칸**이다(사용자 지시) — 학급이 없어도 들어갈 곳이
    하나는 있어야 하고, 그 자리가 매번 바뀌면 손이 기억하지 못한다.

    어느 한 공간의 집계가 실패해도 **그 공간을 빼지 않는다.** 자료 수가 0으로
    보이는 것보다 학급이 목록에서 사라지는 것이 훨씬 나쁘다.
    """
    spaces = await home.get_my_spaces(client, user_id)

    # 학급 사진 경로는 한 번에 읽는다 — 공간마다 따로 물으면 왕복이 는다.
    avatars: dict[str, str | None] = {}
    class_ids = [s["space_ref"] for s in spaces if s["space_kind"] == "class"]
    if class_ids:
        try:
            rows = await client.select(
                "classes",
                {"id": f"in.({','.join(class_ids)})", "select": "id,avatar_path"},
            )
            avatars = {str(r["id"]): r.get("avatar_path") for r in rows}
        except Exception:  # noqa: BLE001
            logger.warning("학급 사진 경로 조회 실패", exc_info=True)

    out: list[dict[str, Any]] = []
    for s in spaces:
        kind = s["space_kind"]
        ref = str(s["space_ref"])
        sessions: list[str] = []
        try:
            sessions = await _session_ids(client, kind, ref)
        except Exception:  # noqa: BLE001
            logger.warning("세션 목록 조회 실패: %s/%s", kind, ref, exc_info=True)

        concepts: list[str] = []
        try:
            concepts = await _top_concepts(client, sessions)
        except Exception:  # noqa: BLE001
            logger.warning("개념 집계 실패: %s/%s", kind, ref, exc_info=True)

        materials, lectures = (0, 0)
        if kind == "class":
            materials, lectures = await _class_counts(client, ref)

        out.append(
            {
                "space_kind": kind,
                "space_ref": ref,
                "name": s.get("name") or ("개인 공간" if kind == "personal" else "학급"),
                "role_in_class": s.get("role_in_class"),
                "sessions": len(sessions),
                "materials": materials,
                "lectures": lectures,
                "concepts": concepts,
                "has_avatar": bool(avatars.get(ref)) if kind == "class" else False,
            }
        )
    return out
