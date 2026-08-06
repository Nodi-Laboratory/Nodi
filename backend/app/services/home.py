"""Home dashboard data queries.

Plain, read-only, RLS-scoped queries used by the `/home/*` router. No LLM here.
"""

from __future__ import annotations

from typing import Any

from ..db.client import UserClient


async def get_my_spaces(
    client: UserClient, owner_id: str
) -> list[dict[str, Any]]:
    """Personal space + joined classes, as logical spaces."""
    spaces: list[dict[str, Any]] = [
        {
            "space_kind": "personal",
            "space_ref": owner_id,
            "name": "개인 공간",
            "role_in_class": None,
        }
    ]
    rows = await client.select(
        "class_members",
        {
            "user_id": f"eq.{owner_id}",
            "select": "class_id,role_in_class,classes(id,name)",
        },
    )
    for r in rows:
        cls = r.get("classes") or {}
        if not isinstance(cls, dict) or not cls.get("id"):
            continue
        spaces.append(
            {
                "space_kind": "class",
                "space_ref": cls["id"],
                "name": cls.get("name") or "학급",
                "role_in_class": r.get("role_in_class"),
            }
        )
    return spaces


async def get_recent_sessions(
    client: UserClient,
    space_kind: str | None = None,
    space_ref: str | None = None,
    limit: int = 8,
) -> list[dict[str, Any]]:
    """Most-recently-updated sessions, optionally scoped to one space."""
    params: dict[str, str] = {
        "select": "id,title,emoji,space_kind,space_ref,updated_at",
        "order": "updated_at.desc",
        "limit": str(limit),
    }
    if space_kind:
        params["space_kind"] = f"eq.{space_kind}"
    if space_ref:
        params["space_ref"] = f"eq.{space_ref}"
    return await client.select("sessions", params)



# --- 개념 지도 (D189) --------------------------------------------------------
#
# 홈은 "지난 대화 목록"이었다. 목록은 **언제 했는지**만 말해 준다 — 학생이
# 알고 싶은 것은 "내가 무엇을 아는가"와 "그것들이 어떻게 이어지는가"다.
# 캔버스의 지도가 세션 하나를 보여 준다면, 이쪽은 **전부**를 한 장에 펼친다.

CONCEPT_MAP_MAX_NODES = 1200
"""지도에 올리는 카드 수 상한.

한 학기치라도 이 아래다(카드 300장이 열심히 쓴 한 달). 넘으면 최근 것부터
자른다 — 오래된 개념이 화면 밖으로 밀리는 편이, 브라우저가 멎는 것보다 낫다.
"""

CONCEPT_MAP_NEIGHBORS = 6
"""카드 하나가 가질 선의 최대 개수.

늘리면 지도가 털뭉치가 된다(모든 것이 모든 것과 이어지면 아무 구조도 안 보인다).
6이면 무리가 갈라지면서도 무리 안이 끊기지 않는다.
"""

CONCEPT_MAP_MAX_DISTANCE = 0.66
"""이보다 먼 쌍은 **선을 긋지 않는다.**

D182가 실물 임베딩으로 잰 세 구간을 그대로 쓴다 — 중복 0.223~0.347 ·
연결 0.500~0.618 · 남남 0.693~0.765. 0.66은 연결과 남남 사이의 빈 곳이다.
게이트가 없으면 남남까지 이어져 지도가 한 덩어리가 된다.
"""

CONCEPT_MAP_SELECT = "id,session_id,title,body,tag,created_at"


async def get_concept_map(
    client: UserClient, owner_id: str
) -> dict[str, Any]:
    """지금까지 대화한 개념 전부 + 비슷한 것끼리의 선 (D189).

    ## 노드는 RLS가 정하고, 선은 Qdrant가 준다

    노드 목록을 Qdrant에서 받으면 **신뢰 경계를 넘는다**(불변식). 여기서는
    `canvas_items`를 USER 클라이언트로 읽어 노드를 정하고, Qdrant가 준 쌍 중
    **양 끝이 그 목록에 있는 것만** 남긴다. 벡터 저장소가 남의 카드를 흘려도
    지도에 뜨지 않는다.

    ## 학생 메모는 없다 (사용자 결정 2026-08-06)

    임베딩이 있는 것은 AI 개념 카드뿐이라, 메모를 넣으면 **의미로 못 묶는다** —
    아무 데나 놓인 점이 된다. 넣으려면 메모에도 임베딩을 붙여야 한다.
    """
    from . import qdrant_store  # 지연 임포트 — 지도만 Qdrant를 탄다

    rows = await client.select(
        "canvas_items",
        {
            "select": CONCEPT_MAP_SELECT,
            "kind": "eq.concept",
            "source": "eq.ai",
            "order": "created_at.desc",
            "limit": str(CONCEPT_MAP_MAX_NODES),
        },
    )
    if not rows:
        return {"nodes": [], "edges": [], "sessions": []}

    # 세션 정보는 **클릭했을 때 어디로 갈지**를 정한다(공간이 다르면 라우트가
    # 다르다). 카드마다 붙이면 같은 문자열이 수백 번 실려 가므로 따로 낸다.
    session_ids = sorted({str(r["session_id"]) for r in rows if r.get("session_id")})
    sessions = await client.select(
        "sessions",
        {
            "select": "id,title,space_kind,space_ref,updated_at",
            "id": f"in.({','.join(session_ids)})",
        },
    )

    ids = {str(r["id"]) for r in rows}
    pairs = await qdrant_store.concept_pairs(
        owner_id,
        sample=CONCEPT_MAP_MAX_NODES,
        neighbors=CONCEPT_MAP_NEIGHBORS,
    )
    edges = [
        {"a": a, "b": b, "distance": round(d, 4)}
        for a, b, d in pairs
        # 양 끝이 **RLS로 확인된 노드**일 때만. Qdrant는 신뢰 경계가 아니다.
        if a in ids and b in ids and a != b and d <= CONCEPT_MAP_MAX_DISTANCE
    ]

    nodes = [
        {
            "id": str(r["id"]),
            "session_id": str(r["session_id"]) if r.get("session_id") else None,
            "title": (r.get("title") or "").strip(),
            # 본문은 미리보기 한 줄만 — 지도는 읽는 곳이 아니라 찾는 곳이다.
            "preview": " ".join((r.get("body") or "").split())[:120],
            "tag": (r.get("tag") or "").strip() or None,
            "created_at": r.get("created_at"),
        }
        for r in rows
    ]
    return {"nodes": nodes, "edges": edges, "sessions": sessions}
