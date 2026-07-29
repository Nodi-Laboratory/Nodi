"""TASK 6-1 (D120) — 잡 하트비트 touch_job 테스트.

장기 잡(atom_batch·figure 캡션 생성·의미 청킹)이 N콜마다 jobs.updated_at을
전진시켜 스테일 복구(120초)의 오탐 재클레임을 막는다. 하트비트 실패는 삼킨다 —
하트비트가 잡을 죽이면 본말전도다. 외부 의존은 전부 mock.
"""

import pytest

from app.services.worker import common


class _FakeSvc:
    def __init__(self):
        self.updates = []

    async def update(self, table, filters, patch):
        self.updates.append((table, filters, patch))
        return [{}]


@pytest.mark.asyncio
async def test_touch_job_updated_at_전진():
    svc = _FakeSvc()
    await common.touch_job(svc, "job-1")
    assert svc.updates and svc.updates[0][0] == "jobs"
    assert svc.updates[0][1] == {"id": "eq.job-1"}
    assert "updated_at" in svc.updates[0][2]


@pytest.mark.asyncio
async def test_touch_job_실패는_삼킨다():
    class _Boom:
        async def update(self, *a):
            raise RuntimeError("db down")

    await common.touch_job(_Boom(), "job-1")  # raise하지 않아야 한다
