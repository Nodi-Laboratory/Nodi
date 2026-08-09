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
import re
from typing import Any, NamedTuple

from fastapi import HTTPException, status

from ..db.client import UserClient, get_service_client

logger = logging.getLogger("nodi.canvas_items")

# 표준 UUID. 프론트의 `ids.ts` `isRealId`와 같은 판정이다 — 임시 id
# (`tmp-…`·`local-note-…`)를 uuid 열에 넘기면 asyncpg가 DataError를 던진다.
_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I
)

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


class InkCards(NamedTuple):
    """표시 주변 카드 블록 + **어느 것이 대상인지.**

    대상을 따로 내는 이유는, 그것이 프롬프트에 **우리 말로** 들어가야 하기
    때문이다. 예전에는 비전 모델이 쓴 산문("화살표가 [카드 2]를 가리킨다")만
    넣고 SOLAR가 거기서 대상을 읽어 내기를 기대했다 — 그런데 그 산문은 트리
    지도·자료 블록 사이에 끼여 있고, SOLAR는 자주 고른 노드(`pickedId`)나
    지도의 흐름을 따라갔다(사용자 보고 2026-08-05: "vlm이 카드 2를 가리킨다고
    말해도 SOLAR는 다른 카드를 설명한다").

    **어느 카드를 짚었는지는 기하가 이미 정확히 안다.** 모델에게 추론시킬
    일이 아니다 — VLM에서 배운 것과 같은 교훈이다.
    """

    block: str
    #: "[카드 2] 천문학" 꼴. 비어 있으면 확실히 짚은 것이 없다는 뜻이다.
    targets: list[str]


async def ink_cards_context(
    client: UserClient,
    session_id: str,
    card_ids: list[str],
    body_max_chars: int,
    pointed: list[int] | None = None,
) -> InkCards | None:
    """표시 주변 카드를 프롬프트 블록으로 (D178). 없으면 None.

    ## 왜 클라이언트가 보낸 본문을 안 쓰나

    프론트는 카드 **id만** 보낸다. 본문을 실어 보내면 그것이 그대로 프롬프트에
    들어가는데, 그건 기존 신뢰 경계 규약(D104)과 결이 안 맞는다 — 사용자가
    보낸 문자열은 검증 대상이지 근거가 아니다. 여기서 RLS 경로로 다시 읽으면
    "학생이 자기 세션의 자기 카드를 짚었다"가 DB에서 강제된다.

    ## 번호는 우리가 매기지 않는다

    `card_ids`의 **순서가 곧 `[카드 N]`의 N**이다. 그 번호는 이미 도식 그림에
    배지로 박혀 있고 비전 모델의 설명도 그 번호를 쓴다. 여기서 다시 매기면
    설명과 본문이 다른 카드를 가리키는데, **그 답은 그럴싸해서 아무도 못 잡는다.**

    찾지 못한 id는 **조용히 뺀다**(지워졌거나 남의 것이다). 번호는 그대로
    유지한다 — 빈 번호가 있는 편이 번호가 밀리는 것보다 안전하다.

    ## uuid가 아닌 id를 반드시 걸러야 한다

    캔버스에는 **아직 저장되지 않은 아이템이 있다** — 이번 턴에 막 생긴 카드나
    학생이 방금 쓴 메모는 `tmp-4`·`local-note-…` 같은 임시 id를 단다(`ids.ts`
    `isRealId`가 가려내는 그것). 그런 id가 섞이면 `canvas_items.id`(uuid)에
    캐스팅하다 asyncpg가 `DataError`를 던지고, 호출부의 `except`가 그것을 삼켜
    **표시 맥락이 통째로 사라진다**(실측 2026-08-05: `invalid UUID 'tmp-4'`).
    학생 눈에는 "동그라미를 쳤는데 AI가 못 알아본다"인데 로그에는 이유가 안
    남는다. 하나가 성치 않다고 나머지를 버리지 않는다 — **번호 자리만 비운다.**
    """
    ids = [i for i in card_ids if i]
    if not ids:
        return None
    # 조회는 uuid만. 임시 id는 아직 서버에 없으므로 찾을 수도 없다.
    real = [i for i in ids if _UUID_RE.fullmatch(i)]
    if not real:
        return None
    rows = await client.select(
        "canvas_items",
        {
            "select": "id,title,body,tag",
            "session_id": f"eq.{session_id}",
            "id": f"in.({','.join(real)})",
        },
    )
    by_id = {str(r.get("id")): r for r in rows}
    lines: list[str] = []
    targets: list[str] = []
    want = set(pointed or ())
    for n, cid in enumerate(ids, start=1):
        row = by_id.get(cid)
        if not row:
            continue
        title = (row.get("title") or row.get("tag") or "제목 없음").strip()
        body = " ".join((row.get("body") or "").split())[:body_max_chars]
        # **짚은 카드에는 표를 단다.** 이 줄과 위의 결론 줄이 같은 말을 두 번
        # 하는 셈인데, 프롬프트가 길어질수록 결론 줄 하나는 묻힌다.
        head = f"[카드 {n}] {title}"
        if n in want:
            head += " ← 학생이 짚은 카드"
            targets.append(f"[카드 {n}] {title}")
        lines.append(f"{head}: {body}" if body else head)
    if not lines:
        return None
    return InkCards("\n".join(lines), targets)



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
    out = created if isinstance(created, list) else [created]
    await _enqueue_crosslinks(out)
    return out


async def _enqueue_crosslinks(created: list[dict[str, Any]]) -> None:
    """새 AI 개념 카드마다 교차 연결 잡을 en큐한다 (D171).

    **어떤 실패도 저장을 되돌리지 않는다.** 학생의 글이 이미 들어간 뒤이고,
    연결은 있으면 좋은 것이지 저장의 전제가 아니다 — 잡을 못 걸면 그 카드에
    링크가 안 생길 뿐이다(나중에 백필로 채운다).

    워커 DSN이 없으면(get_service_client None) 조용히 건너뛴다 — files.py
    업로드 경로와 같은 계약이다.
    """
    svc = get_service_client()
    if svc is None:
        return
    targets = [
        r for r in created
        if r.get("kind") == "concept"
        and r.get("source") == "ai"
        and (r.get("body") or "").strip()
    ]
    if not targets:
        return
    try:
        await svc.insert(
            "jobs",
            [
                {"kind": "crosslink", "target_id": str(r["id"]), "status": "queued"}
                for r in targets
            ],
            returning=False,
        )
    except Exception:  # noqa: BLE001 - en큐 실패는 저장을 되돌리지 않는다
        logger.warning("교차 연결 잡 en큐 실패 (카드 %d개)", len(targets), exc_info=True)


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


# 컬럼 → SQL 타입. `update_many`가 jsonb 페이로드를 풀 때 쓴다 (D183).
# **PATCHABLE과 짝이다** — 여기 없는 컬럼은 대량 수정으로 바꿀 수 없다.
PATCH_TYPES = {
    "x": "double precision",
    "y": "double precision",
    "pinned": "boolean",
    "title": "text",
    "body": "text",
    "tag": "text",
    "seq": "integer",
    "data": "jsonb",
    "parent_item_id": "uuid",
}

# 한 번에 고칠 수 있는 아이템 수. 재배치는 캔버스 전체를 옮길 수 있으므로
# 생성 상한(50)보다 넉넉해야 한다. 넘으면 프론트가 나눠 보낸다.
MAX_PATCH_PER_CALL = 400


async def patch_items(
    client: UserClient, session_id: str, entries: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """여러 아이템을 **각자 다른 값으로** 한 번에 수정 (D183).

    ## 왜 필요한가

    재배치(`handleRegroup`)·가지 이동·별 포인터로 떼어내기는 카드 수십~수백
    장을 한꺼번에 옮긴다. 프론트는 그것을 `PATCH /canvas/items/{id}` 하나씩으로
    보냈다 — 카드 150장이면 **요청 150개, 트랜잭션 150개**다. 브라우저는 한
    출처에 동시 연결을 6개쯤으로 묶으므로 25번 줄을 서고, 되돌리기를 누르면
    같은 수가 한 번 더 나간다(실측 2026-08-06: 지연 0인 로컬에서 842ms).

    ## 부분 성공을 성공이라 하지 않는다

    RLS가 막은 행은 조용히 빠진다. 그대로 200을 주면 프론트는 전부 저장됐다고
    믿고 낙관적 화면을 유지하는데, 새로고침하면 일부만 남아 있다 —
    **그 어긋남은 화면에도 로그에도 안 드러난다.** 하나라도 빠지면 409로
    알리고 프론트가 통째로 되돌린다.

    ## 세션 울타리

    단건 경로는 아이템 id만 받는다(RLS가 판정하므로 안전하다). 여기는 세션
    하위 경로라 `session_id`를 한 번 더 건다 — 한 요청이 여러 세션에 걸치는
    일은 정상 동작에 없다.
    """
    if not entries:
        return []
    if len(entries) > MAX_PATCH_PER_CALL:
        raise _bad(
            f"한 번에 수정할 수 있는 아이템은 {MAX_PATCH_PER_CALL}개까지입니다"
            f"(요청 {len(entries)}개)."
        )
    await _assert_session(client, session_id)

    # ## 왜 컬럼 조합으로 묶나
    #
    # 한 문장으로 합치려면 안 보낸 컬럼을 "지금 값 유지"로 표현해야 하는데,
    # `COALESCE(v.col, t.col)`로 풀면 **NULL로 지우기가 막힌다** — 별 포인터로
    # 가지를 떼는 일(tag=null·parent_item_id=null)이 정확히 그 동작이라
    # 학생이 떼어낸 가지가 도로 붙는다. 조용히 틀리는 쪽이라 더 나쁘다.
    #
    # 그래서 **같은 컬럼 집합끼리만** 한 문장으로 묶는다. 호출부 하나가 내는
    # 조합은 보통 하나(재배치는 x·y·pinned)이고, 많아야 둘셋이다.
    groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    for e in entries:
        item_id = str(e.get("id") or "")
        if not _UUID_RE.fullmatch(item_id):
            raise _bad(f"아이템 id가 아닙니다: {item_id!r}")
        patch = dict(e.get("patch") or {})
        unknown = set(patch) - PATCHABLE
        if unknown:
            raise _bad(f"수정할 수 없는 필드입니다: {sorted(unknown)}")
        if not patch:
            raise _bad(f"수정할 내용이 없습니다: {item_id}")
        groups.setdefault(tuple(sorted(patch)), []).append(
            {"id": item_id, **patch}
        )

    updated: list[dict[str, Any]] = []
    for cols, rows in groups.items():
        updated += await client.update_many(
            "canvas_items",
            rows,
            types={"id": "uuid", **{c: PATCH_TYPES[c] for c in cols}},
            filters={"session_id": f"eq.{session_id}"},
        )
    if len(updated) != len(entries):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{len(entries)}개 중 {len(updated)}개만 저장했습니다.",
        )
    logger.info(
        "캔버스 아이템 %d개 수정 (문장 %d개) session=%s",
        len(entries), len(groups), session_id,
    )
    return updated


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


# --- 태그별 대화 트리 컨텍스트 (D151) ---------------------------------------

ITEM_TREE_SELECT = "id,parent_item_id,tag,title,body,kind,source,seq"
"""트리를 세우는 데 필요한 최소 열."""

TREE_BODY_CHARS = 300
"""카드 하나에서 가져올 본문 길이."""

TREE_MAX_CHARS = 24000
"""트리 블록 전체 상한.

컨텍스트를 **자르지 않는 것**이 사용자 결정이지만(2026-08-02) 무한은 아니다.
카드가 수백 개인 세션에서 프롬프트가 모델 한계를 넘으면 턴 자체가 죽는다.
넘치면 **오래된 것부터** 버린다 — 최근 대화가 지금 질문과 가깝다.
"""


LOOSE_TAG = " untagged"
"""분류 없는 가지가 모이는 트리의 열쇠 (D180).

학생이 별 포인터로 가지를 떼어내면 그 가지는 **분류 없는 가지**가 된다. 그래도
트리이긴 해야 한다 — 안 그러면 떼어낸 순간 가지 안쪽 관계까지 사라져 AI가 받는
순서가 낱장으로 흩어진다.

⚠️ 프론트 `tree.ts`의 `LOOSE_TAG`와 **같은 문자열**이다.
"""


def _tree_key(r: dict[str, Any]) -> str:
    return (r.get("tag") or "").strip() or LOOSE_TAG


def _tree_lines(rows: list[dict[str, Any]]) -> dict[str, list[tuple[int, dict]]]:
    """행 목록 → 태그별 (깊이, 행) 목록. 태그 순서는 첫 등장 순서.

    ## 프론트와 같은 규칙이어야 한다

    간선 판정은 `frontend/src/lib/canvas2/tree.ts`와 **글자 그대로 같은 규칙**
    이다: AI가 쓴 개념 카드가 노드이고, 부모가 존재하며 **트리 열쇠가 같을 때만**
    이어진다. 한쪽만 고치면 학생이 화면에서 본 트리와 AI가 받는 순서가 갈린다.

    **태그를 요구하지 않는다** (D180) — 분류 없는 카드끼리도 `LOOSE_TAG` 트리를
    이룬다. 그래야 떼어낸 가지가 화면에서든 프롬프트에서든 모양을 유지한다.
    """
    nodes = [
        r
        for r in rows
        if r.get("kind") == "concept" and r.get("source") == "ai"
    ]
    nodes.sort(key=lambda r: r.get("seq") or 0)
    by_id = {r["id"]: r for r in nodes}

    def linked_parent(r: dict) -> str | None:
        p = r.get("parent_item_id")
        if not p:
            return None
        parent = by_id.get(p)
        if not parent:
            return None
        return p if _tree_key(parent) == _tree_key(r) else None

    kids: dict[str, list[dict]] = {}
    roots: dict[str, list[dict]] = {}
    order: list[str] = []
    for r in nodes:
        tag = _tree_key(r)
        if tag not in roots:
            roots[tag] = []
            order.append(tag)
        p = linked_parent(r)
        if p:
            kids.setdefault(p, []).append(r)
        else:
            roots[tag].append(r)

    out: dict[str, list[tuple[int, dict]]] = {}
    for tag in order:
        flat: list[tuple[int, dict]] = []
        seen: set[str] = set()
        # 재귀 대신 스택으로 편다. 루프 안에서 클로저를 만들면 `flat`·`seen`을
        # 늦게 묶어(ruff B023) 태그가 여럿일 때 엉뚱한 목록에 쌓인다.
        stack: list[tuple[dict, int]] = [(r, 0) for r in reversed(roots[tag])]
        while stack:
            row, depth = stack.pop()
            if row["id"] in seen:  # 순환 방어
                continue
            seen.add(row["id"])
            flat.append((depth, row))
            for child in reversed(kids.get(row["id"], [])):
                stack.append((child, depth + 1))
        out[tag] = flat
    return out


async def session_tree_context(
    client: UserClient, session_id: str, focus_tag: str | None = None
) -> str | None:
    """세션의 카드를 **태그별 트리 순서**로 편 텍스트 (D151).

    사용자 결정(2026-08-02): 옛 Nodi는 컨텍스트를 줄이려고 분기를 갈랐지만,
    지금은 **전부 넣고 AI가 판단하게 한다.** 대신 순서를 준다 — 태그마다
    한 덩어리, 그 안에서는 부모→자식 순서다. 어떤 답이 어떤 답에서 나왔는지가
    줄바꿈과 들여쓰기로 드러난다.

    `focus_tag`가 있으면 그 트리에 표시를 단다. 자르는 것이 아니라
    **가리키는 것**이다.

    실패하면 None — 컨텍스트 빌더는 best-effort다("RAG는 채팅을 절대 막지
    않는다"와 같은 정신).
    """
    rows = await client.select(
        "canvas_items",
        {
            "select": ITEM_TREE_SELECT,
            "session_id": f"eq.{session_id}",
            "order": "seq.asc",
        },
    )
    trees = _tree_lines(rows)
    if not trees:
        return None

    blocks: list[tuple[bool, str]] = []  # (지금 보고 있는 트리인가, 본문)
    for tag, flat in trees.items():
        # 분류 없는 가지는 이름이 없다 — 학생이 떼어내 놓은 것이라고 말해 준다.
        head = "## (분류를 떼어 놓은 가지)" if tag == LOOSE_TAG else f"## [{tag}]"
        focused = bool(focus_tag) and tag == focus_tag
        if focused:
            head += "  ← 학생이 지금 보고 있는 트리"
        lines = [head]
        for depth, r in flat:
            title = (r.get("title") or "").strip()
            body = " ".join((r.get("body") or "").split())[:TREE_BODY_CHARS]
            pad = "  " * depth
            label = title or body[:40] or "(제목 없음)"
            lines.append(f"{pad}- {label}" + (f": {body}" if body else ""))
        blocks.append((focused, "\n".join(lines)))

    # ── 넘치면 버린다 — 단, **보고 있는 트리는 남긴다** ─────────────────
    #
    # 오래된 것부터 버리는 규칙 자체는 옳다("최근 대화가 지금 질문과 가깝다").
    # 그런데 태그 순서는 **첫 등장 순서**라, 학기 초에 만든 트리로 돌아가
    # 복습하듯 이어 물으면 **그 트리가 첫 번째 버림 대상**이 된다 — 실측
    # 2026-08-09(태그 6종 × 카드 20장): 학생이 보고 있던 '판 구조론'이 통째로
    # 사라지고 무관한 트리 셋만 남았다. `focus_tag`로 "여기를 보고 있다"고
    # 가리켜 놓고 정작 그 내용을 안 준 셈이다.
    #
    # 지금 보고 있는 트리는 **마지막까지 남긴다.** 그것만으로 상한을 넘으면
    # 그때는 잘라서라도 남긴다 — 없는 것보다 잘린 것이 낫다.
    def _join(bs: list[tuple[bool, str]]) -> str:
        return "\n\n".join(b for _, b in bs)

    text = _join(blocks)
    while len(text) > TREE_MAX_CHARS and len(blocks) > 1:
        drop = next((i for i, (f, _) in enumerate(blocks) if not f), None)
        if drop is None:
            break  # 남은 것이 전부 초점 트리다 — 아래에서 잘린다.
        blocks.pop(drop)
        text = _join(blocks)
    return text[:TREE_MAX_CHARS] if text else None
