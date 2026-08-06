"""D195 — embedding_batch가 청크를 쪼개 병렬로 임베딩한다.

여기서 지키는 것 셋:

1. **동시에 나간다.** 요청이 순차면 잡 하나의 시간이 요청 수에 비례해 늘어난다
   (그게 D195 이전이다). 진행 중인 요청 수를 세서 확인한다 — 시간으로 재면
   느린 CI에서 흔들린다.
2. **벡터가 자기 청크에 붙는다.** 조각을 완료 순서로 이어붙이면 벡터가 밀리는데,
   그 결과는 "검색이 좀 이상하다"로만 드러나고 예외는 안 난다.
3. **실패는 슬라이스에서 끝난다.** 요청 하나가 죽어도 성공한 청크는 embedded로
   남는다 — 재시도 비용을 그만큼 덜 문다.
"""

import asyncio
import re

import pytest

from app.services import app_settings, embedding, upstage
from app.services.worker import batch, common


# ---------------------------------------------------------------------------
# 인메모리 FakeService (다른 워커 테스트와 같은 패턴)
# ---------------------------------------------------------------------------
def _range_bounds(cond, field):
    lo = hi = None
    for op, val in re.findall(rf"{field}\.(gte|lt)\.(\d+)", cond):
        if op == "gte":
            lo = int(val)
        if op == "lt":
            hi = int(val)
    return lo, hi


def _match(row, filters):
    for key, cond in filters.items():
        if key in ("select", "limit", "order"):
            continue
        if key == "and":
            lo, hi = _range_bounds(cond, "seq")
            if lo is not None and row.get("seq", 0) < lo:
                return False
            if hi is not None and row.get("seq", 0) >= hi:
                return False
            continue
        if not isinstance(cond, str):
            continue
        if cond.startswith("eq.") and str(row.get(key)) != cond[3:]:
            return False
        if cond.startswith("neq.") and str(row.get(key)) == cond[4:]:
            return False
    return True


class _FakeService:
    def __init__(self, chunks, jobs):
        self.tables = {
            "file_chunks": [dict(c) for c in chunks],
            "jobs": [dict(j) for j in jobs],
        }
        self.file_row = {"id": "f1", "owner_id": "u1"}
        self.updates = []

    async def select(self, table, params):
        if table == "files":
            return [dict(self.file_row)]
        return [dict(r) for r in self.tables.get(table, []) if _match(r, params)]

    async def count(self, table, params):
        return sum(1 for r in self.tables.get(table, []) if _match(r, params))

    async def update(self, table, filters, patch):
        self.updates.append((table, filters, patch))
        for r in self.tables.get(table, []):
            if _match(r, filters):
                r.update(patch)
        return [patch]

    async def insert(self, table, rows, returning=True):
        return []

    def chunk_status(self):
        return {r["seq"]: r["status"] for r in self.tables["file_chunks"]}

    def job_status(self):
        return self.tables["jobs"][0]["status"]


def _chunks(n):
    return [
        {"id": f"c{i}", "file_id": "f1", "seq": i,
         "chunk_text": f"본문 {i}", "status": "pending"}
        for i in range(n)
    ]


def _job(n):
    return {
        "id": "j1", "kind": "embedding_batch", "target_id": "f1",
        "batch_range": {"from_seq": 0, "to_seq": n}, "status": "running",
    }


@pytest.fixture
def wired(monkeypatch):
    """임베딩·Qdrant를 인메모리로 갈아끼우고 오버레이를 비운다."""
    monkeypatch.setattr(app_settings, "get_overlay", lambda: _empty_overlay())
    upserted: list[dict] = []

    async def _upsert(points, collection=None):
        upserted.extend(points)

    monkeypatch.setattr(common, "_qdrant_upsert", _upsert)
    # 하트비트는 30초 뒤에나 도는데, 테스트가 그만큼 살지 않으므로 그대로 둔다.
    return upserted


async def _empty_overlay():
    return {}


@pytest.mark.asyncio
async def test_슬라이스는_동시에_나간다(monkeypatch, wired):
    """요청 250개(=슬라이스 3)가 겹쳐서 돈다 — 순차면 최대 동시 1이다."""
    live = 0
    peak = 0

    async def fake_embed(texts, *, task_type="RETRIEVAL_DOCUMENT", concurrency=None):
        nonlocal live, peak
        live += 1
        peak = max(peak, live)
        await asyncio.sleep(0.01)  # 겹칠 틈을 준다
        live -= 1
        return [[0.0] * upstage.EMBED_DIM for _ in texts]

    monkeypatch.setattr(embedding, "embed_texts", fake_embed)
    svc = _FakeService(_chunks(250), [_job(250)])
    await batch._handle_batch(svc, _job(250))

    assert peak >= 2, f"슬라이스가 순차로 돌았다(최대 동시 {peak})"
    assert svc.job_status() == "done"
    assert set(svc.chunk_status().values()) == {"embedded"}


@pytest.mark.asyncio
async def test_벡터는_자기_청크에_붙는다(monkeypatch, wired):
    """완료 순서가 뒤집혀도 청크↔벡터 짝이 유지된다.

    뒤 슬라이스를 **먼저** 끝내 놓고(앞 슬라이스에 지연) 짝을 확인한다 —
    이어붙이는 순서가 완료 순서면 여기서 어긋난다.
    """
    async def fake_embed(texts, *, task_type="RETRIEVAL_DOCUMENT", concurrency=None):
        # 첫 슬라이스(본문 0으로 시작)만 늦게 끝낸다.
        if texts[0].endswith(" 0"):
            await asyncio.sleep(0.03)
        # 벡터 0번 칸에 청크 번호를 심어 짝을 추적한다.
        return [
            [float(t.split()[-1])] + [0.0] * (upstage.EMBED_DIM - 1) for t in texts
        ]

    monkeypatch.setattr(embedding, "embed_texts", fake_embed)
    svc = _FakeService(_chunks(250), [_job(250)])
    await batch._handle_batch(svc, _job(250))

    assert len(wired) == 250
    for p in wired:
        seq = int(p["id"][1:])            # "c137" -> 137
        assert p["vector"][0] == float(seq), f"{p['id']}에 다른 벡터가 붙었다"
        assert p["payload"] == {"chunk_id": p["id"], "file_id": "f1", "owner_id": "u1"}


@pytest.mark.asyncio
async def test_한_슬라이스가_죽어도_나머지는_남는다(monkeypatch, wired):
    """429 한 번이 잡 전체를 되돌리지 않는다 — 실패한 100개만 failed."""
    async def fake_embed(texts, *, task_type="RETRIEVAL_DOCUMENT", concurrency=None):
        if texts[0].endswith(" 100"):     # 두 번째 슬라이스만 실패
            raise RuntimeError("429 Too Many Requests")
        return [[0.0] * upstage.EMBED_DIM for _ in texts]

    monkeypatch.setattr(embedding, "embed_texts", fake_embed)
    svc = _FakeService(_chunks(250), [_job(250)])
    await batch._handle_batch(svc, _job(250))

    status = svc.chunk_status()
    assert [status[s] for s in (0, 99)] == ["embedded", "embedded"]
    assert [status[s] for s in (100, 199)] == ["failed", "failed"]
    assert [status[s] for s in (200, 249)] == ["embedded", "embedded"]
    # 잡은 실패로 남아야 재시도 동선이 성립한다. 사유에 실패 청크 수가 들어간다.
    assert svc.job_status() == "failed"
    detail = [u for u in svc.updates if u[0] == "jobs" and u[2].get("status") == "failed"]
    assert "100/250" in detail[0][2]["error"]


@pytest.mark.asyncio
async def test_이미_끝난_청크는_다시_임베딩하지_않는다(monkeypatch, wired):
    """pending만 고른다 — 재시도가 성공분을 다시 돈다면 요금이 두 배다."""
    called = []

    async def fake_embed(texts, *, task_type="RETRIEVAL_DOCUMENT", concurrency=None):
        called.extend(texts)
        return [[0.0] * upstage.EMBED_DIM for _ in texts]

    monkeypatch.setattr(embedding, "embed_texts", fake_embed)
    chunks = _chunks(10)
    for c in chunks[:7]:
        c["status"] = "embedded"
    svc = _FakeService(chunks, [_job(10)])
    await batch._handle_batch(svc, _job(10))

    assert len(called) == 3
    assert svc.job_status() == "done"
