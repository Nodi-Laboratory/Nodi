"""캔버스 아이템 · 그림 엔드포인트 (D122).

세션 하위 경로(`/sessions/{id}/canvas*`)와 아이템 단건 경로(`/canvas/items/{id}`)로
나뉜다. 단건 경로에 session_id를 넣지 않는 이유: 아이템 id만으로 RLS가 판정할 수
있고, 프론트가 드래그할 때마다 세션 id를 함께 들고 다니지 않아도 된다.

파싱·배치는 전부 프론트다. 서버는 저장만 한다(services/canvas_items.py docstring).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..db.client import UserClient
from ..services import canvas_items as svc
from ..services import item_links as links_svc

router = APIRouter(tags=["canvas"])


class NewItem(BaseModel):
    """생성 입력 1건. 값 검증은 서비스가 한다(kind/source 화이트리스트 등)."""

    kind: str = "concept"
    source: str = "ai"
    node_id: str | None = None
    parent_item_id: str | None = None
    title: str | None = None
    body: str = ""
    tag: str | None = None
    x: float = 0
    y: float = 0
    pinned: bool = False
    seq: int = 0
    data: dict[str, Any] = Field(default_factory=dict)


class CreateItemsBody(BaseModel):
    items: list[NewItem]


class PatchItemBody(BaseModel):
    """부분 수정. **미지정과 null을 구분해야 하므로** 기본값을 센티넬로 둔다.

    `tag: None`은 "태그를 지운다"이고, tag 키가 없는 것은 "건드리지 마라"다.
    Pydantic 기본값(None)만 쓰면 둘을 구분할 수 없어, 위치만 옮겼는데 태그가
    지워지는 사고가 난다. `model_dump(exclude_unset=True)`로 구분한다.
    """

    x: float | None = None
    y: float | None = None
    pinned: bool | None = None
    title: str | None = None
    body: str | None = None
    tag: str | None = None
    seq: int | None = None
    data: dict[str, Any] | None = None
    parent_item_id: str | None = None


class PutDrawingBody(BaseModel):
    elements: list[dict[str, Any]] = Field(default_factory=list)
    files: dict[str, Any] = Field(default_factory=dict)


@router.get("/sessions/{session_id}/canvas")
async def get_canvas(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """아이템 + 그림. 캔버스 재수화의 유일한 입구다."""
    return await svc.list_canvas(UserClient.from_user(user), session_id)


@router.post("/sessions/{session_id}/canvas/items", status_code=status.HTTP_201_CREATED)
async def create_items(
    session_id: str,
    body: CreateItemsBody,
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    return await svc.create_items(
        UserClient.from_user(user),
        session_id,
        [it.model_dump() for it in body.items],
    )


@router.put("/sessions/{session_id}/canvas/drawing")
async def put_drawing(
    session_id: str,
    body: PutDrawingBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    return await svc.put_drawing(
        UserClient.from_user(user), session_id, body.elements, body.files
    )


@router.patch("/canvas/items/{item_id}")
async def patch_item(
    item_id: str,
    body: PatchItemBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    # exclude_unset — 보내지 않은 필드는 건드리지 않는다(위 docstring 참조).
    return await svc.patch_item(
        UserClient.from_user(user), item_id, body.model_dump(exclude_unset=True)
    )


@router.delete("/canvas/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(
    item_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> None:
    await svc.delete_item(UserClient.from_user(user), item_id)


# ---------------------------------------------------------------------------
# 교차 세션 개념 연결 (D171)
#
# 링크는 **워커만 만든다** — 학생이 임의의 두 카드를 이어 붙일 수 있으면 이
# 기능의 의미가 사라진다(item_links에 INSERT 정책이 없다). 여기 있는 것은
# 읽기와 "열어 봤다" 표식뿐이다.
# ---------------------------------------------------------------------------
@router.get("/sessions/{session_id}/canvas/links")
async def list_links(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    return await links_svc.list_links(UserClient.from_user(user), session_id)


@router.post("/canvas/links/{link_id}/open")
async def open_link(
    link_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """열어 본 표식 — 깜빡임을 멈춘다. 멱등."""
    return await links_svc.mark_opened(UserClient.from_user(user), link_id)
