"""Home dashboard endpoint.

- GET /home/summary   spaces + recent sessions

Scope decision: /home/summary is account-wide (not space-scoped) — spaces across
all memberships and recent sessions across all spaces.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from ..auth.deps import CurrentUser, get_current_user
from ..db.client import UserClient
from ..services import home

router = APIRouter(prefix="/home", tags=["home"])


@router.get("/summary")
async def home_summary(
    recent_limit: int = Query(8, ge=1, le=30),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    client = UserClient.from_user(user)
    spaces = await home.get_my_spaces(client, user.id)
    recents = await home.get_recent_sessions(client, limit=recent_limit)
    return {
        "spaces": spaces,
        "recent_sessions": recents,
    }



@router.get("/concept-map")
async def concept_map(
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """지금까지 대화한 개념 전부 + 비슷한 것끼리의 선 (D189).

    좌표는 **주지 않는다.** 2D 배치는 화면 크기·확대 배율에 따라 달라야 하므로
    브라우저가 힘 배치로 만든다 — 서버가 정하면 창을 줄일 때마다 어긋난다.
    """
    return await home.get_concept_map(UserClient.from_user(user), user.id)
