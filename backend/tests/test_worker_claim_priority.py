"""잡을 뽑는 순서 (D188).

고정하는 계약:
  1. **텍스트가 도판에 굶지 않는다** — 교과서 하나가 도판 잡 수백 개를 만들어도
     본문 임베딩이 먼저 뽑힌다. 이게 이 변경의 존재 이유다.
  2. 급한 종류를 **먼저, 종류로 좁혀** 묻는다 — 한 번에 읽어 정렬하면 도판이
     많을 때 텍스트 잡이 창에 아예 안 들어온다.
  3. 남은 자리는 나머지가 채운다 — 도판을 굶기자는 것이 아니다.
  4. 클레임 경쟁에서 지면(0행) 세지 않는다.
  5. limit을 넘겨 뽑지 않는다.

이 파일이 없어서 굶는 것을 아무도 못 잡았다 — 화면에는 "진행 0%"로만 보였다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.services.worker import jobs as J

aio = pytest.mark.asyncio


class FakeSvc:
    """queued 잡을 들고 있다가 select 조건대로 돌려주는 대역."""

    def __init__(self, queued: list[dict], lose: set[str] | None = None):
        self.queued = queued
        self.lose = lose or set()
        self.selects: list[dict] = []

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        assert table == "jobs"
        self.selects.append(params)
        rows = [j for j in self.queued if j.get("status", "queued") == "queued"]
        kind = params.get("kind")
        if kind:
            wanted = kind.removeprefix("in.(").rstrip(")").split(",")
            rows = [r for r in rows if r["kind"] in wanted]
        rows.sort(key=lambda r: r["created_at"])
        return rows[: int(params["limit"])]

    async def update(self, table: str, filters: dict, patch: dict) -> list[dict]:
        jid = filters["id"].removeprefix("eq.")
        job = next((j for j in self.queued if j["id"] == jid), None)
        if job is None or job.get("status") != "queued" or jid in self.lose:
            return []
        job["status"] = "running"
        return [{**job, **patch}]


def _jobs(kind: str, n: int, at: str, start: int = 0) -> list[dict]:
    return [
        {"id": f"{kind}-{i}", "kind": kind, "created_at": at, "status": "queued",
         "attempts": 0}
        for i in range(start, start + n)
    ]


@aio
async def test_텍스트가_도판에_굶지_않는다():
    """존재 이유 — 도판 200개와 텍스트 5개가 **같은 순간에** 생겼을 때."""
    svc = FakeSvc(_jobs("figure_batch", 200, "2026-08-06T06:10:22")
                  + _jobs("embedding_batch", 5, "2026-08-06T06:10:22"))
    claimed = await J._claim_jobs(svc, 3)
    assert [c["kind"] for c in claimed] == ["embedding_batch"] * 3


@aio
async def test_급한_종류를_먼저_좁혀_묻는다():
    """한 번에 읽어 정렬하면 도판이 많을 때 텍스트가 창에 안 들어온다."""
    svc = FakeSvc(_jobs("figure_batch", 50, "2026-08-06T06:10:22"))
    await J._claim_jobs(svc, 3)
    assert "kind" in svc.selects[0]
    for k in J.URGENT_KINDS:
        assert k in svc.selects[0]["kind"]


@aio
async def test_남은_자리는_나머지가_채운다():
    """도판을 굶기자는 것이 아니다 — 급한 것이 없으면 도판이 다 가져간다."""
    svc = FakeSvc(_jobs("figure_batch", 10, "2026-08-06T06:10:22")
                  + _jobs("embedding_batch", 1, "2026-08-06T06:10:22"))
    claimed = await J._claim_jobs(svc, 4)
    kinds = [c["kind"] for c in claimed]
    assert kinds[0] == "embedding_batch"
    assert kinds.count("figure_batch") == 3


@aio
async def test_파싱이_임베딩보다도_급하다():
    """`embedding_split`이 끝나야 나머지 잡이 생긴다 — 둘 다 급한 목록에 있다."""
    assert "embedding_split" in J.URGENT_KINDS
    assert "embedding_batch" in J.URGENT_KINDS


@aio
async def test_클레임에_지면_세지_않는다():
    """다른 워커가 먼저 가져간 잡을 처리하면 같은 일을 두 번 한다."""
    svc = FakeSvc(_jobs("embedding_batch", 3, "2026-08-06T06:10:22"),
                  lose={"embedding_batch-0"})
    claimed = await J._claim_jobs(svc, 3)
    assert [c["id"] for c in claimed] == ["embedding_batch-1", "embedding_batch-2"]


@aio
async def test_limit을_넘기지_않는다():
    svc = FakeSvc(_jobs("embedding_batch", 5, "2026-08-06T06:10:22")
                  + _jobs("figure_batch", 5, "2026-08-06T06:10:22"))
    claimed = await J._claim_jobs(svc, 2)
    assert len(claimed) == 2


@aio
async def test_큐가_비면_아무것도_안_뽑는다():
    svc = FakeSvc([])
    assert await J._claim_jobs(svc, 3) == []


@aio
async def test_오래된_것부터_뽑는다():
    """같은 종류 안에서는 먼저 만들어진 것이 먼저다(기존 계약)."""
    svc = FakeSvc(_jobs("embedding_batch", 1, "2026-08-06T07:00:00", start=9)
                  + _jobs("embedding_batch", 1, "2026-08-06T06:00:00", start=1))
    claimed = await J._claim_jobs(svc, 1)
    assert claimed[0]["id"] == "embedding_batch-1"
