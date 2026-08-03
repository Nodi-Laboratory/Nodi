"""캔버스 아이템 · 그림 (D122 — 캔버스 v2).

학생이 편집할 수 있는 캔버스의 저장 계층이다. `nodes`(대화 기록)와 역할이
다르다 — `nodes`는 AI가 실제로 뭐라고 했는지의 원본이고, 여기는 학생이 옮기고
고친 결과다. 학생이 본문을 수정해도 `nodes.answer`는 그대로 남는다.

## 왜 좌표를 저장하는가 (D105 폐기)

D105는 "카드 좌표를 저장하지 않는다"였고, 자동 배치만 있던 시절에는 옳았다.
학생이 드래그로 옮길 수 있게 되면 성립하지 않는다 — 옮긴 자리를 안 남기면
새로고침마다 학생의 작업이 사라진다. 대신 `pinned`로 두 세계를 나눈다:

    pinned=false  배치 엔진이 자리를 정한다(결정론 유지)
    pinned=true   학생이 정한 자리. 엔진은 장애물로만 읽는다

## 파싱은 서버가 하지 않는다

`body`는 AI 응답 원문(마크업 포함)을 그대로 담는다. 개념 카드 형식을 파싱하는
구현이 이미 셋(프론트 conceptParser / solar.extract_used_tags /
ai.skills.concepts._parse_cards)이고 관용도가 서로 다르다. 네 번째를 만들면
반드시 어긋난다. 스트리밍 증분 파서는 프론트에만 있으면 된다.

## 권한

전부 `UserClient`(RLS)로만 돈다. 워커(BYPASSRLS)로 우회하지 않는다 —
"권한은 DB가 강제한다"(D104)를 캔버스라고 예외로 두지 않는다.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import HTTPException, status

from ..db.client import UserClient

logger = logging.getLogger("nodi.canvas_items")

ITEM_SELECT = (
    "id,session_id,node_id,parent_item_id,kind,source,title,body,tag,"
    "x,y,pinned,seq,data,created_at,updated_at"
)

KINDS = ("concept", "note", "figure", "clip")
SOURCES = ("ai", "user")

# 한 번에 만들 수 있는 아이템 수. 모델이 형식을 어겨 개념을 수십 개 뱉어도
# DB와 화면을 지키는 선이다. 넘으면 조용히 자르지 않고 422로 알린다 —
# 잘라 버리면 학생 화면에는 있는데 저장은 안 된 아이템이 생긴다.
MAX_ITEMS_PER_CALL = 50

# 그림 씬 페이로드 상한(직렬화 바이트). 자유선이 많은 스케치도 보통 수백 KB다.
# 2MB를 넘으면 무언가 잘못된 것이고, 그대로 받으면 매 저장마다 왕복 비용이 된다.
MAX_DRAWING_BYTES = 2 * 1024 * 1024

# PATCH로 바꿀 수 있는 필드. **화이트리스트다.**
# session_id·owner 계열을 절대 넣지 마라 — 다른 세션으로 아이템을 옮기는
# 경로가 열린다(RLS는 UPDATE 시점의 session_id로 판정하므로 자기 세션에서
# 남의 세션으로 밀어 넣는 것까지는 막지만, 애초에 허용할 이유가 없다).
PATCHABLE = frozenset(
    {"x", "y", "pinned", "title", "body", "tag", "seq", "data", "parent_item_id"}
)


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail)


async def _assert_session(client: UserClient, session_id: str) -> None:
    """세션이 보이는지 확인 — 안 보이면 404.

    RLS가 어차피 막지만, 그 경우 INSERT는 0행으로 조용히 성공한 것처럼 보인다.
    호출부가 "저장됐다"고 믿게 두지 않는다.
    """
    rows = await client.select(
        "sessions", {"select": "id", "id": f"eq.{session_id}", "limit": "1"}
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="세션을 찾을 수 없습니다."
        )


async def list_canvas(client: UserClient, session_id: str) -> dict[str, Any]:
    """아이템 + 그림을 한 번에. 재수화의 유일한 입구다.

    두 번 왕복하지 않는 이유: 아이템만 먼저 오면 그림 없는 캔버스가 한 프레임
    보였다가 그림이 튀어 들어온다.
    """
    await _assert_session(client, session_id)
    items = await client.select(
        "canvas_items",
        {
            "select": ITEM_SELECT,
            "session_id": f"eq.{session_id}",
            "order": "seq.asc",
        },
    )
    drawings = await client.select(
        "canvas_drawings",
        {"select": "elements,files,updated_at", "session_id": f"eq.{session_id}", "limit": "1"},
    )
    return {
        "items": items,
        "drawing": drawings[0] if drawings else {"elements": [], "files": {}},
    }


async def session_tags(
    client: UserClient, session_id: str, cap: int = 40
) -> list[str]:
    """이 세션에서 이미 쓰인 분류 태그 — **첫 등장 순서**로 (D135).

    ## 왜 canvas_items에서 읽나

    태그의 진짜 소유자는 이 표다. 예전 경로(`solar.extract_used_tags`)는
    `nodes.answer` 본문에서 `@concept:` 줄을 정규식으로 긁었는데, 그러면
    **학생이 ⋯ 메뉴로 직접 바꾼 분류가 AI에게 안 보인다.** 학생이 "생명과학
    기초"를 "생명과학"으로 고쳐 놔도 모델은 계속 옛 태그를 만들어 낸다.

    실패해도 턴을 막지 않는다 — 태그 안내는 있으면 좋은 것이지 필수가 아니다
    ("RAG는 채팅을 절대 막지 않는다"와 같은 정신).
    """
    # `not.is.null`은 이 클라이언트가 지원하지 않는다(`is.null`만 있다).
    # 넣었다가 UnsupportedQuery로 조용히 죽었다 — 걸러내기는 파이썬에서 한다.
    rows = await client.select(
        "canvas_items",
        {
            "select": "tag,seq",
            "session_id": f"eq.{session_id}",
            "order": "seq.asc",
        },
    )
    out: list[str] = []
    for r in rows:
        t = (r.get("tag") or "").strip()
        if t and t not in out:
            out.append(t)
        if len(out) >= cap:
            break
    return out


def _clean_new(session_id: str, raw: dict[str, Any]) -> dict[str, Any]:
    """생성 입력 1건 검증 + 정규화. 알 수 없는 키는 버린다."""
    kind = str(raw.get("kind") or "concept")
    source = str(raw.get("source") or "ai")
    if kind not in KINDS:
        raise _bad(f"kind는 {KINDS} 중 하나여야 합니다: {kind!r}")
    if source not in SOURCES:
        raise _bad(f"source는 {SOURCES} 중 하나여야 합니다: {source!r}")

    def num(key: str) -> float:
        try:
            return float(raw.get(key) or 0)
        except (TypeError, ValueError) as exc:
            raise _bad(f"{key}는 숫자여야 합니다.") from exc

    return {
        "session_id": session_id,
        "node_id": raw.get("node_id") or None,
        "parent_item_id": raw.get("parent_item_id") or None,
        "kind": kind,
        "source": source,
        "title": raw.get("title") or None,
        "body": str(raw.get("body") or ""),
        "tag": raw.get("tag") or None,
        "x": num("x"),
        "y": num("y"),
        "pinned": bool(raw.get("pinned", False)),
        "seq": int(raw.get("seq") or 0),
        "data": raw.get("data") or {},
    }


async def create_items(
    client: UserClient, session_id: str, items: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """아이템 배치 생성. 스트림이 끝나면 프론트가 한 번에 부른다."""
    if not items:
        return []
    if len(items) > MAX_ITEMS_PER_CALL:
        raise _bad(
            f"한 번에 만들 수 있는 아이템은 {MAX_ITEMS_PER_CALL}개까지입니다"
            f"(요청 {len(items)}개)."
        )
    await _assert_session(client, session_id)
    rows = [_clean_new(session_id, it) for it in items]
    created = await client.insert("canvas_items", rows)
    logger.info("캔버스 아이템 %d개 생성 session=%s", len(rows), session_id)
    return created if isinstance(created, list) else [created]


async def patch_item(
    client: UserClient, item_id: str, patch: dict[str, Any]
) -> dict[str, Any]:
    """부분 수정. 화이트리스트 밖 키는 **거절한다**(조용히 무시하지 않는다).

    무시하면 프론트가 "저장됐다"고 믿고 넘어가는데 값은 안 바뀐 상태가 된다.
    그 고장은 화면에 안 드러난다 — 새로고침해야 알 수 있다.
    """
    unknown = set(patch) - PATCHABLE
    if unknown:
        raise _bad(f"수정할 수 없는 필드입니다: {sorted(unknown)}")
    if not patch:
        raise _bad("수정할 내용이 없습니다.")

    rows = await client.update("canvas_items", {"id": f"eq.{item_id}"}, patch)
    if not rows:
        # RLS가 막았거나 없는 id다. 둘을 구분해 주지 않는다(존재 여부 노출 방지).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="아이템을 찾을 수 없습니다."
        )
    return rows[0]


async def delete_item(client: UserClient, item_id: str) -> None:
    rows = await client.delete("canvas_items", {"id": f"eq.{item_id}"})
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="아이템을 찾을 수 없습니다."
        )


async def put_drawing(
    client: UserClient,
    session_id: str,
    elements: list[dict[str, Any]],
    files: dict[str, Any],
) -> dict[str, Any]:
    """그림 씬 전체 교체. 프론트가 디바운스해서 부른다.

    부분 갱신을 하지 않는 이유: Excalidraw 요소는 서로 참조(그룹·바인딩)하고
    한 번의 조작이 여러 요소를 동시에 바꾼다. 델타를 정확히 만들려면 사실상
    Excalidraw의 화해(reconciliation)를 재구현해야 한다. 씬은 수백 KB고
    디바운스가 1.5초라 통째로 보내는 편이 단순하고 안전하다.
    """
    await _assert_session(client, session_id)

    # 지워진 요소는 저장하지 않는다. Excalidraw는 tombstone으로 들고 있는데
    # (실행 취소용) 그대로 쌓으면 씬이 단조 증가한다.
    live = [e for e in elements if not e.get("isDeleted")]

    payload = {"elements": live, "files": files}
    size = len(json.dumps(payload, ensure_ascii=False).encode())
    if size > MAX_DRAWING_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"그림이 너무 큽니다({size // 1024}KB). "
            f"{MAX_DRAWING_BYTES // 1024}KB까지 저장할 수 있습니다.",
        )

    return await client.upsert(
        "canvas_drawings",
        {"session_id": session_id, "elements": live, "files": files},
        on_conflict="session_id",
    )
