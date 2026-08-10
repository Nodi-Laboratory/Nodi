"""Session + node persistence and ancestor-chain context assembly.

Conversation model (architecture.md §3, §4):
  - 1 node = one (question, answer) pair.
  - Context for a turn = the ancestor chain ONLY (root -> ... -> parent),
    siblings excluded.
All writes go through the caller's RLS-scoped UserClient (owner-only).
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from ..db.client import UserClient

# Columns returned to the client for tree reconstruction.
# D107: connections(기억 연결)·reference_sources(비교 참조)는 제거됐다 —
# 캔버스 UI에 그 둘을 만드는 경로가 없어 항상 비어 있었다.
# `attachments`(0001 jsonb)의 "canvas" 키는 캔버스 리프 노드(교과서 도판) 영속분 —
# 세션 재수화 때 FigureNode를 복원하려면 함께 내려줘야 한다(C5).
# D105: position_x/position_y는 select에서 뺐다 — 좌표의 소유자는 프론트
# d3-force이고 서버는 저장하지 않는다. 매 세션 조회마다 항상 NULL인 컬럼 두 개를
# 실어 보내고 있었다.
NODE_SELECT = (
    "id,session_id,parent_id,question,answer,label,"
    "rag_sources,attachments,created_at"
)
SESSION_SELECT = (
    "id,owner_id,space_kind,space_ref,title,emoji,root_node_id,"
    "current_head_id,created_at,updated_at"
)


# ----------------------------------------------------------------------------
# Sessions
# ----------------------------------------------------------------------------
async def create_session(
    client: UserClient,
    owner_id: str,
    space_kind: str,
    space_ref: str | None,
    title: str | None,
) -> dict[str, Any]:
    if space_kind not in ("personal", "class"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="space_kind must be 'personal' or 'class'.",
        )
    # personal space_ref defaults to the owner's own id (per data model).
    ref = space_ref or (owner_id if space_kind == "personal" else None)
    if space_kind == "class" and not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class sessions require space_ref (class id).",
        )
    # D202: 빈 대화가 이미 있으면 그것을 준다 — 새로 만들지 않는다.
    if title is None:
        reusable = await _empty_session(client, space_kind, ref)
        if reusable is not None:
            return reusable
    row = {
        "owner_id": owner_id,
        "space_kind": space_kind,
        "space_ref": ref,
        "title": title,
    }
    return await client.insert("sessions", row)


async def _empty_session(
    client: UserClient, space_kind: str, ref: str | None
) -> dict[str, Any] | None:
    """이 공간의 **가장 최근 대화가 아직 비어 있으면** 그 행을 돌려준다 (D202).

    "새 대화"를 누를 때마다 행이 하나씩 생긴다. 그런데 학생이 그 대화에서
    아무것도 안 하고 나가는 일이 훨씬 흔하다 — 서랍을 열었다가 닫고, 홈에서
    다시 들어오고, 다른 학급으로 옮긴다. 실측(2026-08-07): 개인 공간 하나에
    **211개**가 쌓였고 대부분이 글 한 줄 없는 빈 대화다. 목록이 "새 대화"
    수십 줄로 덮이면 정작 찾던 대화가 스크롤 밑으로 밀린다.

    ⚠️ **지우지 않는다.** 자동 정리는 학생이 쓴 것을 지울 위험이 있고, 되돌릴
    방법도 없다. 여기서는 **안 만드는** 쪽으로 푼다 — 빈 대화는 서로
    구분할 수 없으므로 그중 하나를 다시 여는 것은 아무것도 잃지 않는다.

    비어 있다 = 제목이 없고 · 캔버스 아이템이 없고 · 붙인 파일이 없다.
    파일까지 보는 이유: 자료만 올려 둔 대화를 재사용하면 그 파일이 다음
    질문의 컨텍스트로 조용히 딸려 간다(학생은 올린 적이 없다고 기억한다).
    """
    recent = await client.select(
        "sessions",
        {
            "space_kind": f"eq.{space_kind}",
            "space_ref": f"eq.{ref}",
            "select": SESSION_SELECT,
            "order": "updated_at.desc",
            "limit": "1",
        },
    )
    if not recent or (recent[0].get("title") or "").strip():
        return None
    sid = recent[0]["id"]
    if await client.count("canvas_items", {"session_id": f"eq.{sid}"}):
        return None
    if await client.count("files", {"session_id": f"eq.{sid}"}):
        return None
    # 턴이 있었으면 빈 대화가 아니다 (2026-08-09).
    #
    # `canvas_items`가 0인데 답이 있는 방이 실제로 존재한다 — 카드는 **화면이**
    # 만들기 때문이다. 스트리밍 도중에 새로고침하면 서버는 `nodes`에 답을
    # 남기고 카드는 안 생긴다. v2 이전 대화도 같은 모양이고, 화면은 그런 방을
    # `nodes`에서 읽어 `legacy-…` 카드로 그린다.
    #
    # 그 방을 "비었다"고 보고 재사용하면 **학생이 "새 대화"를 눌렀는데 지난
    # 답이 그대로 있는 방**이 열린다(실측 2026-08-09: 카드 `legacy-…` 한 장이
    # 새 대화에 그대로 떠 있었다. e2e 두 건이 이 자리에서 멈췄다).
    #
    # D202의 근거는 "빈 대화는 서로 구분할 수 없으니 하나를 다시 열어도
    # 아무것도 안 잃는다"였다. 이 방은 구분이 된다 — 그러니 새로 만든다.
    if await client.count("nodes", {"session_id": f"eq.{sid}"}):
        return None
    return recent[0]


#: 목록으로 한 번에 내주는 대화 수 (2026-08-10).
#:
#: 상한이 **없었다.** 그 공간의 대화를 전부 줬다 — 실측: 개인 공간 435건 156KB.
#: 대화는 지우지 않는 이상 계속 쌓이므로 그 무게도 계속 는다. 한 학기 쓴 학생이
#: 서랍을 열 때마다 그만큼을 받는 셈이다.
#:
#: 최근 것부터 준다. 옛 대화를 되찾는 길은 따로 있어야 하지만(검색·기간), 그때도
#: **한 번에 전부**가 답인 적은 없다.
_LIST_CAP = 200


async def list_sessions(
    client: UserClient,
    space_kind: str,
    space_ref: str | None,
    owner_id: str,
    q: str | None = None,
) -> list[dict[str, Any]]:
    """이 공간의 대화 목록. 최근 것부터 `_LIST_CAP`개까지.

    `q`가 있으면 **이름으로 찾는다** (2026-08-10).

    상한만 두고 끝내면 201번째 대화에는 닿을 길이 아예 없어진다 — "지워지지
    않았어요"라고 써 놓고 갈 길을 안 주는 것은 안내가 아니라 막다른 길이다.
    찾기를 서버까지 보내면 상한 밖의 옛 대화도 이름으로 불러올 수 있다.
    """
    # personal space_ref defaults to the owner's own id (mirrors create_session).
    ref = space_ref or (owner_id if space_kind == "personal" else None)
    if space_kind == "class" and not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class sessions require space_ref (class id).",
        )
    params: dict[str, str] = {
        "space_kind": f"eq.{space_kind}",
        "space_ref": f"eq.{ref}",
        "select": SESSION_SELECT,
        "order": "updated_at.desc",
        "limit": str(_LIST_CAP),
    }
    if q and q.strip():
        params["title"] = f"ilike.{q.strip()}"
    return await client.select("sessions", params)


async def update_session_title(
    client: UserClient, session_id: str, title: str
) -> dict[str, Any]:
    """Rename a session (RLS sessions_update_owner -> owner only)."""
    rows = await client.update(
        "sessions",
        {"id": f"eq.{session_id}"},
        {"title": title},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or not yours.",
        )
    return rows[0]


async def delete_session(client: UserClient, session_id: str) -> None:
    """Delete a session (nodes cascade; files.session_id -> null, see 0011).

    ⚠️ **지웠는지 확인한다.** RLS(`sessions_delete_owner`)는 남의 방을 지우려는
    시도에 오류를 내지 않는다 — **0행을 지우고 조용히 끝난다.** 그대로 두면
    창구가 204를 돌려주고, 화면은 목록에서 그 줄을 지운 뒤 새로고침에서 되살아
    난다(실측 2026-08-10의 학급 사진과 같은 부류의 결함이다).

    선생님은 학급의 학생 방을 **볼 수** 있고(`sessions_select`), 그래서 목록에
    남의 방이 뜬다 — 이 경로는 실제로 닿는다.
    """
    rows = await client.delete("sessions", {"id": f"eq.{session_id}"})
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or not yours.",
        )


async def get_session(client: UserClient, session_id: str) -> dict[str, Any]:
    rows = await client.select(
        "sessions",
        {"id": f"eq.{session_id}", "select": SESSION_SELECT, "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or not accessible.",
        )
    return rows[0]


async def get_session_nodes(
    client: UserClient, session_id: str
) -> list[dict[str, Any]]:
    return await client.select(
        "nodes",
        {
            "session_id": f"eq.{session_id}",
            "select": NODE_SELECT,
            "order": "created_at.asc",
        },
    )


# ----------------------------------------------------------------------------
# Nodes + context
# ----------------------------------------------------------------------------
def ancestor_chain_nodes(
    nodes: list[dict[str, Any]], node_id: str | None
) -> list[dict[str, Any]]:
    """Ancestor chain node dicts (root -> ... -> node_id), siblings excluded."""
    if not node_id:
        return []
    by_id = {n["id"]: n for n in nodes}
    chain: list[dict[str, Any]] = []
    cursor = by_id.get(node_id)
    guard = 0
    while cursor is not None and guard < 10000:
        chain.append(cursor)
        cursor = by_id.get(cursor.get("parent_id"))
        guard += 1
    chain.reverse()  # root first
    return chain


async def append_node(
    client: UserClient,
    session_id: str,
    parent_id: str | None,
    question: str,
    answer: str,
    label: str | None,
) -> dict[str, Any]:
    """Atomically insert the (Q+A) node AND advance the session head/root.

    Backed by the append_chat_node() Postgres RPC (migration 0004) so the node
    can never be orphaned with a stale current_head_id. The RPC enforces
    ownership (sessions.owner_id = auth.uid()) inside the transaction.
    """
    result = await client.rpc(
        "append_chat_node",
        {
            "p_session_id": session_id,
            "p_parent_id": parent_id,
            "p_question": question,
            "p_answer": answer,
            "p_label": label,
        },
    )
    # A row-returning function may come back as a single object or a
    # one-element list, depending on how PostgREST resolves it.
    if isinstance(result, list):
        if not result:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Failed to save node.",
            )
        return result[0]
    return result

