"""D76 — 잡 즉시 예외 경로의 재시도·파일 터미널 전환 테스트.

split 잡이 예외로 죽을 때: attempts가 남으면 재큐, 소진 시 잡 failed +
files.status='failed'(고착 방지). batch 잡 소진 시 _finalize_file(partial 경로).
"""

import pytest

from app.services import embedding_worker as W


class _FakeService:
    """update 호출을 (table, filters, values)로 기록하는 대역."""

    def __init__(self):
        self.updates = []

    async def update(self, table, filters, values):
        self.updates.append((table, filters, values))
        return [values]


def _boom(monkeypatch, handler_name):
    async def boom(svc, job):
        raise RuntimeError("upstage 400")

    monkeypatch.setattr(W, handler_name, boom)


@pytest.mark.asyncio
async def test_split_exception_attempts_left_requeues(monkeypatch):
    """attempts가 남으면 잡을 재큐하고 파일은 건드리지 않는다."""
    _boom(monkeypatch, "_handle_split")
    svc = _FakeService()
    job = {"id": "j1", "kind": "embedding_split", "target_id": "f1", "attempts": 1}
    await W._process(svc, job)
    assert all(t != "files" for t, _, _ in svc.updates)
    assert any(
        t == "jobs" and v.get("status") == "queued" for t, _, v in svc.updates
    )


@pytest.mark.asyncio
async def test_split_exception_attempts_exhausted_fails_file(monkeypatch):
    """⑦ attempts 소진 시 잡 failed + files.status='failed' + error 기록."""
    _boom(monkeypatch, "_handle_split")
    svc = _FakeService()
    job = {
        "id": "j1",
        "kind": "embedding_split",
        "target_id": "f1",
        "attempts": W.settings.embedding_max_attempts,
    }
    await W._process(svc, job)
    file_updates = [v for t, _, v in svc.updates if t == "files"]
    assert any(v.get("status") == "failed" and v.get("error") for v in file_updates)
    assert any(
        t == "jobs" and v.get("status") == "failed" for t, _, v in svc.updates
    )


@pytest.mark.asyncio
async def test_batch_exception_attempts_exhausted_finalizes(monkeypatch):
    """batch 잡 소진 시 기존 _finalize_file 경로(partial)로 마감한다."""
    _boom(monkeypatch, "_handle_batch")
    finalized = []

    async def fake_finalize(svc, file_id):
        finalized.append(file_id)

    monkeypatch.setattr(W, "_finalize_file", fake_finalize)
    svc = _FakeService()
    job = {
        "id": "j2",
        "kind": "embedding_batch",
        "target_id": "f2",
        "attempts": W.settings.embedding_max_attempts,
        "batch_range": {},
    }
    await W._process(svc, job)
    assert finalized == ["f2"]
