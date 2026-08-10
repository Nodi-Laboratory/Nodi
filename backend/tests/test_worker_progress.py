"""색인 진행도가 **뒤로 가지 않는다** (2026-08-10).

배치 여럿이 한 파일의 조각을 나눠 임베딩하고, 끝날 때마다 `_finalize_file`이
남은 조각을 다시 센다. 둘이 거의 동시에 끝나면 각자 **다른 시점의 개수**를
들고 오는데, 예전에는 그중 어느 쪽이 화면에 남는지가 순서에 달려 있었다.

  A가 센다(248) → B가 센다(250) → B가 쓴다(indexed, 250)
                                → A가 쓴다: `status != indexed` 가드에 걸려
                                  **통째로 건너뜀**

순서가 반대면 248이 박힌 채 굳는다. 실측 2026-08-10: 조각 250개가 전부
embedded인데 파일은 `indexed` / **248/250**이었다. 교사 눈에는 다 되지 않은
자료다 — 다시 올리거나, 안 쓰거나, 둘 중 하나를 하게 된다.

고정하는 계약 셋:
  1. 다 끝나면 `indexed`이고 진행도도 **전부**를 가리킨다.
  2. 늦게 온 **작은** 숫자가 큰 숫자를 덮지 않는다.
  3. 아직 남았으면(pending) 상태는 그대로 두고 진행도만 올린다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.services.worker import jobs

aio = pytest.mark.asyncio


class FakeSvc:
    """ServiceClient 대역 — 조각 수를 정해 주고 update를 기록한다."""

    def __init__(self, *, embedded: int, failed: int = 0, pending: int = 0):
        self._counts = {"embedded": embedded, "failed": failed, "pending": pending}
        #: (filters, values) 그대로 — 조건이 실제로 걸렸는지 보려고 남긴다.
        self.updates: list[tuple[dict[str, Any], dict[str, Any]]] = []

    async def count(self, table: str, params: dict) -> int:
        assert table == "file_chunks"
        return self._counts[params["status"].removeprefix("eq.")]

    async def update(self, table: str, filters: dict, values: dict) -> list[dict]:
        self.updates.append((filters, values))
        return []


@aio
async def test_다_끝나면_진행도도_전부를_가리킨다() -> None:
    svc = FakeSvc(embedded=250)
    await jobs._finalize_file(svc, "f1")  # type: ignore[arg-type]

    상태 = [v for _, v in svc.updates if v.get("status") == "indexed"]
    assert 상태 and 상태[0]["chunk_done"] == 250

    # 진행도를 **한 번 더** 맞춘다 — 종결 가드에 걸려 건너뛰었을 수 있으니까.
    올림 = [(f, v) for f, v in svc.updates if set(v) == {"chunk_done"}]
    assert 올림, "진행도 보정이 없다 — 가드에 걸리면 248/250이 굳는다"
    filters, values = 올림[-1]
    assert values["chunk_done"] == 250
    # 조건이 걸려야 늦게 온 작은 숫자가 큰 숫자를 못 덮는다.
    assert filters["chunk_done"] == "lt.250"


@aio
async def test_늦게_온_작은_숫자는_조건에_걸린다() -> None:
    """A(248)가 B(250)보다 늦게 도착해도 화면은 250으로 남아야 한다."""
    svc = FakeSvc(embedded=248)
    await jobs._finalize_file(svc, "f1")  # type: ignore[arg-type]

    올림 = [f for f, v in svc.updates if set(v) == {"chunk_done"}]
    assert 올림[-1]["chunk_done"] == "lt.248"  # 이미 250이면 안 걸린다 → 덮지 못한다


@aio
async def test_아직_남았으면_상태는_안_건드린다() -> None:
    svc = FakeSvc(embedded=100, pending=150)
    await jobs._finalize_file(svc, "f1")  # type: ignore[arg-type]

    assert all("status" not in v for _, v in svc.updates)
    assert svc.updates[-1][1]["chunk_done"] == 100


@aio
async def test_실패한_조각이_있으면_partial이다() -> None:
    """`partial`은 조건 없이 쓴다 — 여기서 진행도가 갈리는 일은 없다."""
    svc = FakeSvc(embedded=240, failed=10)
    await jobs._finalize_file(svc, "f1")  # type: ignore[arg-type]

    _, values = svc.updates[-1]
    assert values == {"chunk_done": 240, "status": "partial"}
