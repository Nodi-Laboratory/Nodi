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
