"""질문 방향성 코치 창구 (D194).

**언제 말을 걸지는 화면이 정한다.** 브랜치(조상 사슬)를 아는 곳이 거기이고
(D151 `assignParents`가 부모를 정한다), 판정 로직을 서버에도 두면 둘이 반드시
갈린다 — 그 어긋남은 "가끔 안 뜬다"로만 보인다.

서버가 하는 일은 **무슨 말을 할지**다: 카드를 RLS로 다시 읽고 모델에게 방향을
묻는다.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, get_current_user
from ..db.client import UserClient
from ..services import question_coach

router = APIRouter(prefix="/coach", tags=["coach"])


class DirectionsBody(BaseModel):
    """브랜치의 카드 id들 — **뿌리부터 n+1번째까지**, 순서대로.

    본문은 안 받는다. id만 받고 서버가 RLS로 다시 읽는다(D104·D178과 같은 계약) —
    사용자가 보낸 문자열은 검증 대상이지 근거가 아니다.
    """

    item_ids: list[str] = Field(default_factory=list, max_length=40)


@router.get("/settings")
async def coach_settings(
    _: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """화면이 발동 시점을 계산하는 데 쓰는 값 (n·켜짐).

    화면이 자기 상수로 들고 있으면 관리자가 콘솔에서 n을 바꿔도 안 따라간다
    (D192에서 여덟 개가 그 상태였다).
    """
    knobs = await question_coach.read_knobs()
    return {"enabled": knobs["enabled"], "min_cards": knobs["min_cards"]}


@router.post("/question-directions")
async def question_directions(
    body: DirectionsBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """이 브랜치에 안 물어본 방향을 고른다. 말할 것이 없으면 `null`.

    **중단이 정상 응답이다.** 200에 `coach: null`을 준다 — 오류로 만들면 화면이
    빨간 배너를 띄우는데, 여기서 아무 말도 안 하는 것은 고장이 아니다.
    """
    knobs = await question_coach.read_knobs()
    if not knobs["enabled"]:
        return {"coach": None}
    got = await question_coach.analyse(
        UserClient.from_user(user), body.item_ids, model=knobs["model"]
    )
    return {"coach": got}
