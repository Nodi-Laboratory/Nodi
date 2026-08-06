"""캔버스 아이템 저장 계층 (D122).

고정하는 계약 다섯:
  1. **PATCH 화이트리스트가 실질적이다** — session_id를 바꿔 다른 세션으로
     아이템을 옮기는 경로가 열리면 안 된다.
  2. **모르는 필드를 조용히 무시하지 않는다** — 무시하면 프론트가 "저장됐다"고
     믿는데 값은 그대로다. 새로고침해야 알 수 있는 고장이다.
  3. **상한이 있다** — 아이템 50개 / 그림 2MB. 모델이 형식을 어기거나 스케치가
     폭주해도 DB와 왕복 비용을 지킨다.
  4. **지워진 요소는 저장하지 않는다** — Excalidraw는 실행 취소용 tombstone을
     들고 있고, 그대로 쌓으면 씬이 단조 증가한다.
  5. **없는 아이템 수정은 404** — RLS가 막았을 때 0행 UPDATE가 성공으로 보이면
     안 된다.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from app.routers import canvas as canvas_router
from app.services import canvas_items as svc

# 동기 테스트(라우터 계약)가 섞여 있어 모듈 전체에 걸지 않는다.
aio = pytest.mark.asyncio


class FakeClient:
    """UserClient 대역 — 호출을 기록하고 정해진 값을 돌려준다."""

    def __init__(self, *, session_exists: bool = True, update_rows: list | None = None):
        self.session_exists = session_exists
        self.update_rows = update_rows
        self.inserted: list[dict[str, Any]] = []
        self.upserted: dict[str, Any] | None = None
        self.updates: list[tuple[dict, dict]] = []
        self.bulk: list[dict[str, Any]] = []

    async def select(self, table: str, params: dict) -> list[dict]:
        if table == "sessions":
            return [{"id": "s1"}] if self.session_exists else []
        return []

    async def insert(self, table: str, rows):
        self.inserted = rows if isinstance(rows, list) else [rows]
        return self.inserted

    async def update(self, table: str, filters: dict, patch: dict):
        self.updates.append((filters, patch))
        return self.update_rows if self.update_rows is not None else [{"id": "i1", **patch}]

    async def update_many(self, table: str, rows: list, *, types, key="id", filters=None):
        self.bulk.append({"rows": rows, "types": types, "filters": filters})
        if self.update_rows is not None:
            return self.update_rows
        return [dict(r) for r in rows]

    async def delete(self, table: str, filters: dict):
        return [{"id": "i1"}]

    async def upsert(self, table: str, row: dict, on_conflict: str):
        self.upserted = row
        return row


# --- 1·2. PATCH 화이트리스트 --------------------------------------------------


@aio
@pytest.mark.parametrize(
    "field",
    ["session_id", "id", "owner_id", "created_at", "updated_at", "kind", "source", "오타"],
)
async def test_화이트리스트_밖_필드는_거절한다(field):
    with pytest.raises(HTTPException) as exc:
        await svc.patch_item(FakeClient(), "i1", {field: "x"})
    assert exc.value.status_code == 422
    assert field in str(exc.value.detail)


@aio
async def test_세션을_옮기는_수정은_불가능하다():
    """가장 위험한 경우 — 남의 세션으로 아이템을 밀어 넣는 경로."""
    assert "session_id" not in svc.PATCHABLE
    c = FakeClient()
    with pytest.raises(HTTPException):
        await svc.patch_item(c, "i1", {"x": 10, "session_id": "다른세션"})
    # 하나라도 거절 대상이면 **아무것도 쓰지 않는다** (부분 적용 금지)
    assert c.updates == []


@aio
async def test_허용된_필드는_통과한다():
    c = FakeClient()
    await svc.patch_item(c, "i1", {"x": 12.5, "y": -3, "pinned": True, "tag": "광합성"})
    assert len(c.updates) == 1
    filters, patch = c.updates[0]
    assert filters == {"id": "eq.i1"}
    assert patch == {"x": 12.5, "y": -3, "pinned": True, "tag": "광합성"}


@aio
async def test_빈_수정은_거절한다():
    with pytest.raises(HTTPException) as exc:
        await svc.patch_item(FakeClient(), "i1", {})
    assert exc.value.status_code == 422


# --- 5. 없는 아이템 -----------------------------------------------------------


@aio
async def test_없는_아이템_수정은_404():
    """RLS가 막으면 UPDATE가 0행이다. 그걸 성공으로 보고하면 안 된다."""
    with pytest.raises(HTTPException) as exc:
        await svc.patch_item(FakeClient(update_rows=[]), "없음", {"x": 1})
    assert exc.value.status_code == 404


@aio
async def test_없는_세션에_생성하면_404():
    with pytest.raises(HTTPException) as exc:
        await svc.create_items(FakeClient(session_exists=False), "s1", [{"body": "x"}])
    assert exc.value.status_code == 404


# --- 3. 상한 -----------------------------------------------------------------


@aio
async def test_아이템_개수_상한():
    too_many = [{"body": f"{i}"} for i in range(svc.MAX_ITEMS_PER_CALL + 1)]
    with pytest.raises(HTTPException) as exc:
        await svc.create_items(FakeClient(), "s1", too_many)
    assert exc.value.status_code == 422


@aio
async def test_상한_안이면_전부_만든다():
    c = FakeClient()
    rows = [{"body": f"{i}", "seq": i} for i in range(svc.MAX_ITEMS_PER_CALL)]
    await svc.create_items(c, "s1", rows)
    assert len(c.inserted) == svc.MAX_ITEMS_PER_CALL
    assert all(r["session_id"] == "s1" for r in c.inserted)


@aio
async def test_그림_크기_상한():
    huge = [{"id": str(i), "t": "x" * 4000} for i in range(600)]  # > 2MB
    with pytest.raises(HTTPException) as exc:
        await svc.put_drawing(FakeClient(), "s1", huge, {})
    assert exc.value.status_code == 413


# --- 4. tombstone 정리 --------------------------------------------------------


@aio
async def test_지워진_요소는_저장하지_않는다():
    c = FakeClient()
    await svc.put_drawing(
        c,
        "s1",
        [
            {"id": "a", "isDeleted": False},
            {"id": "b", "isDeleted": True},
            {"id": "c"},
        ],
        {},
    )
    assert [e["id"] for e in c.upserted["elements"]] == ["a", "c"]


# --- 생성 입력 검증 -----------------------------------------------------------


@aio
@pytest.mark.parametrize(
    "bad", [{"kind": "몰라"}, {"source": "몰라"}, {"kind": "drawing"}]
)
async def test_알_수_없는_kind_source는_거절한다(bad):
    with pytest.raises(HTTPException) as exc:
        await svc.create_items(FakeClient(), "s1", [{"body": "x", **bad}])
    assert exc.value.status_code == 422


@aio
async def test_clip_kind는_통과한다():
    """D149: 강의 클립 캔버스 아이템(kind='clip')이 저장 배치를 죽이지 않는다.

    화이트리스트에 없으면 create_items가 422로 배치 전체를 거절해 그 턴의
    개념 카드까지 함께 사라진다.
    """
    assert "clip" in svc.KINDS
    c = FakeClient()
    await svc.create_items(c, "s1", [{"body": "강의", "kind": "clip"}])
    assert c.inserted[0]["kind"] == "clip"


@aio
async def test_생성은_알_수_없는_키를_버린다():
    """입력에 섞여 온 클라이언트 전용 필드(_height 등)가 INSERT에 새면 안 된다."""
    c = FakeClient()
    await svc.create_items(c, "s1", [{"body": "본문", "_height": 300, "몰라": 1}])
    assert set(c.inserted[0]) == {
        "session_id", "node_id", "parent_item_id", "kind", "source",
        "title", "body", "tag", "x", "y", "pinned", "seq", "data",
    }


# --- 라우터 계약 --------------------------------------------------------------


def _deps(path: str, method: str) -> list[str]:
    for route in canvas_router.router.routes:
        if route.path == path and method in route.methods:
            return [d.call.__name__ for d in route.dependant.dependencies]
    raise AssertionError(f"라우트 없음: {method} {path}")


@pytest.mark.parametrize(
    "path,method",
    [
        ("/sessions/{session_id}/canvas", "GET"),
        ("/sessions/{session_id}/canvas/items", "POST"),
        ("/sessions/{session_id}/canvas/drawing", "PUT"),
        ("/canvas/items/{item_id}", "PATCH"),
        ("/canvas/items/{item_id}", "DELETE"),
    ],
)
def test_모든_캔버스_라우트가_인증을_요구한다(path, method):
    assert "get_current_user" in _deps(path, method)


def test_patch_바디는_미지정과_null을_구분한다():
    """`tag: null`("태그를 지운다")과 tag 미지정("건드리지 마라")이 달라야 한다.

    구분하지 못하면 위치만 옮겼는데 태그가 지워진다.
    """
    only_x = canvas_router.PatchItemBody(x=5).model_dump(exclude_unset=True)
    assert only_x == {"x": 5}

    clear_tag = canvas_router.PatchItemBody(tag=None).model_dump(exclude_unset=True)
    assert clear_tag == {"tag": None}


# --- 6. 대량 수정 (D183) ------------------------------------------------------
#
# 고정하는 계약:
#   · 왕복이 **컬럼 조합 수**만큼이지 아이템 수만큼이 아니다 — 이게 존재 이유다.
#   · NULL로 지우기가 살아 있다 — 별 포인터로 가지를 떼는 동작(D180).
#   · 부분 성공은 성공이 아니다 — 조용히 어긋나면 아무도 못 잡는다.
#   · 단건 경로와 **같은 화이트리스트**를 쓴다.

U1 = "11111111-1111-4111-8111-111111111111"
U2 = "22222222-2222-4222-8222-222222222222"
U3 = "33333333-3333-4333-8333-333333333333"


def _entry(item_id: str, **patch):
    return {"id": item_id, "patch": patch}


@aio
async def test_대량수정은_아이템이_많아도_문장_하나다():
    """존재 이유 그 자체 — 카드 150장을 옮겨도 왕복은 한 번이다."""
    c = FakeClient()
    entries = [_entry(f"{i:08x}-1111-4111-8111-111111111111", x=i * 1.0, y=0.0)
               for i in range(150)]
    out = await svc.patch_items(c, "s1", entries)
    assert len(out) == 150
    assert len(c.bulk) == 1
    assert len(c.bulk[0]["rows"]) == 150


@aio
async def test_컬럼_조합이_다르면_따로_묶는다():
    """섞어 보내도 안 보낸 컬럼이 NULL로 덮이지 않아야 한다."""
    c = FakeClient()
    await svc.patch_items(c, "s1", [
        _entry(U1, x=1.0, y=2.0),
        _entry(U2, x=3.0, y=4.0),
        _entry(U3, tag="광합성"),
    ])
    assert len(c.bulk) == 2
    shapes = sorted(tuple(sorted(set(b["types"]) - {"id"})) for b in c.bulk)
    assert shapes == [("tag",), ("x", "y")]
    # 좌표만 보낸 무리에 tag 컬럼이 끼면 제목·태그가 날아간다
    xy = next(b for b in c.bulk if "x" in b["types"])
    assert "tag" not in xy["types"]


@aio
async def test_null로_지우기가_살아_있다():
    """D180 — 별 포인터로 떼어낸 가지는 태그도 부모도 없다.

    `COALESCE(보낸값, 지금값)`으로 합치면 이 동작이 조용히 막힌다. 학생이
    떼어낸 가지가 도로 붙는데 화면에는 안 드러난다.
    """
    c = FakeClient()
    await svc.patch_items(c, "s1", [_entry(U1, tag=None, parent_item_id=None)])
    row = c.bulk[0]["rows"][0]
    assert row["tag"] is None
    assert row["parent_item_id"] is None
    assert c.bulk[0]["types"]["parent_item_id"] == "uuid"


@aio
async def test_부분_성공은_409다():
    """RLS가 일부를 막았다. 200을 주면 프론트가 전부 저장됐다고 믿는다."""
    c = FakeClient(update_rows=[{"id": U1}])
    with pytest.raises(HTTPException) as exc:
        await svc.patch_items(c, "s1", [_entry(U1, x=1.0), _entry(U2, x=2.0)])
    assert exc.value.status_code == 409


@aio
async def test_대량수정도_같은_화이트리스트를_쓴다():
    """단건과 갈리면 한쪽으로만 뚫린다 — session_id가 그 예다."""
    assert set(svc.PATCH_TYPES) == svc.PATCHABLE
    c = FakeClient()
    with pytest.raises(HTTPException) as exc:
        await svc.patch_items(c, "s1", [_entry(U1, session_id="다른세션")])
    assert exc.value.status_code == 422
    assert c.bulk == []  # 하나라도 거절이면 아무것도 안 쓴다


@aio
async def test_임시_id는_거절한다():
    """아직 저장 안 된 카드(`tmp-4`)가 섞이면 uuid 캐스팅에서 죽는다."""
    c = FakeClient()
    with pytest.raises(HTTPException) as exc:
        await svc.patch_items(c, "s1", [_entry(U1, x=1.0), _entry("tmp-4", x=2.0)])
    assert exc.value.status_code == 422
    assert c.bulk == []


@aio
async def test_세션_울타리가_걸린다():
    """한 요청이 여러 세션에 걸치는 일은 정상 동작에 없다."""
    c = FakeClient()
    await svc.patch_items(c, "s1", [_entry(U1, x=1.0)])
    assert c.bulk[0]["filters"] == {"session_id": "eq.s1"}


@aio
async def test_대량수정_개수_상한():
    c = FakeClient()
    too_many = [_entry(U1, x=1.0)] * (svc.MAX_PATCH_PER_CALL + 1)
    with pytest.raises(HTTPException) as exc:
        await svc.patch_items(c, "s1", too_many)
    assert exc.value.status_code == 422


@aio
async def test_없는_세션에는_대량수정도_404():
    with pytest.raises(HTTPException) as exc:
        await svc.patch_items(FakeClient(session_exists=False), "s1",
                              [_entry(U1, x=1.0)])
    assert exc.value.status_code == 404


def test_대량수정_라우트도_인증을_요구한다():
    assert "get_current_user" in _deps("/sessions/{session_id}/canvas/items", "PATCH")


def test_대량수정_바디도_미지정과_null을_구분한다():
    body = canvas_router.PatchItemsBody.model_validate(
        {"items": [{"id": U1, "patch": {"tag": None}}]}
    )
    assert body.items[0].patch.model_dump(exclude_unset=True) == {"tag": None}
