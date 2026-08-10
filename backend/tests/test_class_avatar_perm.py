"""학급 사진을 **누가** 바꿀 수 있나 (2026-08-10 전면 점검).

## 왜 이 테스트가 생겼나

판정이 두 곳에 있었고 서로 달랐다:

  · `is_class_teacher()`(DB) — 만든 사람 **또는** 교사 구성원
  · `class_avatar.set_avatar` — 만든 사람만

그래서 부담임에게는 교사 콘솔이 학급을 보여 주고 "사진 바꾸기"까지 주는데,
누르면 403이 났다(실측). **화면이 권하는 일을 서버가 거절하면 둘 중 하나가
틀린 것이다.** 나머지 전부가 쓰는 규칙(구성원 포함)에 맞췄고, 그 뜻을 여기에
못 박는다 — 다음에 누가 좁히면 여기서 걸린다.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from app.services import class_avatar

aio = pytest.mark.asyncio

OWNER = "11111111-1111-4111-8111-111111111111"
CO_TEACHER = "22222222-2222-4222-8222-222222222222"
STUDENT = "33333333-3333-4333-8333-333333333333"
CLASS = "44444444-4444-4444-8444-444444444444"


class FakeClient:
    """`class_members`에 부담임 한 명이 있는 학급."""

    def __init__(self) -> None:
        self.selects: list[dict[str, Any]] = []

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        self.selects.append({"table": table, **params})
        if table == "classes":
            return [{"id": CLASS, "name": "3학년 1반", "teacher_id": OWNER, "avatar_path": None}]
        if table == "class_members":
            uid = params.get("user_id", "").removeprefix("eq.")
            role = params.get("role_in_class", "").removeprefix("eq.")
            if uid == CO_TEACHER and role == "teacher":
                return [{"user_id": CO_TEACHER}]
            return []
        return []


@aio
async def test_만든_사람은_구성원을_안_물어봐도_통과한다():
    c = FakeClient()
    assert await class_avatar._is_class_teacher(c, CLASS, OWNER) is True
    # 학급 행 하나만 읽고 끝난다 — 왕복을 아끼는 것이 이 순서의 이유다.
    assert not [s for s in c.selects if s["table"] == "class_members"]


@aio
async def test_교사로_들어온_부담임도_선생님이다():
    c = FakeClient()
    assert await class_avatar._is_class_teacher(c, CLASS, CO_TEACHER) is True


@aio
async def test_학생은_아니다():
    c = FakeClient()
    assert await class_avatar._is_class_teacher(c, CLASS, STUDENT) is False


@aio
async def test_학생이_올리면_403이다():
    """반 전체가 보는 그림이 한 사람 장난에 달리면 안 된다."""
    with pytest.raises(HTTPException) as e:
        await class_avatar.set_avatar(
            FakeClient(),
            class_id=CLASS,
            user_id=STUDENT,
            filename="a.png",
            mime="image/png",
            data=b"\x89PNG",
        )
    assert e.value.status_code == 403


@aio
async def test_부담임은_판정을_통과한다(monkeypatch):
    """403이 아니어야 한다 — 그 뒤는 이 테스트의 관심이 아니다.

    저장소를 **없는 것으로** 둔다(501). 진짜로 올려 버리면 단위 테스트가
    파일을 남기고, 그때부터 이 테스트는 기계 상태에 따라 결과가 갈린다.
    """
    monkeypatch.setattr(class_avatar, "get_service_client", lambda: None)
    with pytest.raises(HTTPException) as e:
        await class_avatar.set_avatar(
            FakeClient(),
            class_id=CLASS,
            user_id=CO_TEACHER,
            filename="a.png",
            mime="image/png",
            data=b"\x89PNG",
        )
    assert e.value.status_code != 403
