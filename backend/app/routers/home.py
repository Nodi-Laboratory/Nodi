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

