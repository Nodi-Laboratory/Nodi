"""D83·D84 — 워커 user_upload 분기 테스트.

user_upload: 오버랩 0 청킹 → 'stored' 저장 → 임베딩 팬아웃 생략 → 즉시
indexed(+context_chars). session_id가 있으면 세션 합산 예산(D84) 초과 시
청크 저장 없이 failed + 한국어 사유. class_material은 기존 팬아웃 유지.
"""

import pytest

from app.services import app_settings, embedding
from app.services.worker import common, split


class _FakeService:
    def __init__(self, file_row, session_files=None):
        self.file_row = file_row
        self.session_files = session_files or []
        self.inserts = []
        self.updates = []
        self.deletes = []

    async def select(self, table, params):
        if table == "files" and "id" in params:
            return [dict(self.file_row)]
        if table == "files" and "session_id" in params:
            return [dict(r) for r in self.session_files]
        return []

    async def count(self, table, params):
        return 0  # 기존 배치 잡 없음(멱등 조기 반환 안 탐)

    async def insert(self, table, rows, returning=True):
        self.inserts.append((table, rows))
        return None

    async def update(self, table, filters, values):
        self.updates.append((table, filters, values))
        return [values]

    async def delete(self, table, params):
        self.deletes.append((table, params))

    async def storage_download(self, bucket, path):
        return b"raw"


async def _overlay():
    return {}


def _file(kind="user_upload", session_id=None):
    return {
        "id": "f1", "owner_id": "u1", "storage_path": "u1/f1/a.txt",
        "mime": "text/plain", "space_ref": None,
        "kind": kind, "session_id": session_id,
    }


def _job():
    return {"id": "j1", "kind": "embedding_split", "target_id": "f1"}


@pytest.fixture(autouse=True)
def _patches(monkeypatch):
    async def fake_extract(data, mime, path):
        return "가" * 3000

    async def fake_qdrant_delete(file_id):
        return None

    monkeypatch.setattr(common, "_extract_text", fake_extract)
    monkeypatch.setattr(common, "_qdrant_delete_file_points", fake_qdrant_delete)
    monkeypatch.setattr(app_settings, "get_overlay", _overlay)


@pytest.mark.asyncio
async def test_user_upload_stores_chunks_without_embedding():
    """① 청크 'stored' 저장 + 임베딩 잡 0 + indexed/context_chars 기록."""
    svc = _FakeService(_file())
    await split._handle_split(svc, _job())

    chunk_inserts = [r for t, r in svc.inserts if t == "file_chunks"]
    assert chunk_inserts, "청크가 저장되어야 한다"
    assert all(row["status"] == "stored" for rows in chunk_inserts for row in rows)
    assert all(t != "jobs" for t, _ in svc.inserts), "임베딩 팬아웃 없어야 한다"

    files_updates = [v for t, _, v in svc.updates if t == "files"]
    final = files_updates[-1]
    assert final["status"] == "indexed"
    assert final["context_chars"] == 3000
    assert final["chunk_total"] == final["chunk_done"]


@pytest.mark.asyncio
async def test_user_upload_chunks_have_no_overlap(monkeypatch):
    """② user_upload는 오버랩 0으로 청킹한다(이어붙이면 원문 복원)."""
    calls = []
    original = embedding.chunk_text

    def spy(text, size, overlap):
        calls.append((size, overlap))
        return original(text, size, overlap)

    monkeypatch.setattr(embedding, "chunk_text", spy)
    svc = _FakeService(_file())
    await split._handle_split(svc, _job())
    assert calls and calls[0][1] == 0

    joined = "".join(
        row["chunk_text"]
        for t, rows in svc.inserts if t == "file_chunks"
        for row in rows
    )
    assert joined == "가" * 3000


@pytest.mark.asyncio
async def test_budget_exceeded_fails_with_korean_reason():
    """③ 세션 합산 예산 초과 → 청크 저장 없이 failed + 한국어 사유(D84)."""
    svc = _FakeService(
        _file(session_id="s1"),
        session_files=[{"id": "f0", "context_chars": 149_000}],
    )
    await split._handle_split(svc, _job())

    assert all(t != "file_chunks" for t, _ in svc.inserts)
    files_updates = [v for t, _, v in svc.updates if t == "files"]
    final = files_updates[-1]
    assert final["status"] == "failed"
    assert "예산" in final["error"]


@pytest.mark.asyncio
async def test_sessionless_user_upload_skips_budget():
    """④ session_id 없는 user_upload는 예산 무관 저장(주입 대상 아님)."""
    svc = _FakeService(_file(session_id=None))
    await split._handle_split(svc, _job())
    assert any(t == "file_chunks" for t, _ in svc.inserts)


@pytest.mark.asyncio
async def test_class_material_still_fans_out():
    """⑤ class_material 회귀 가드 — pending 청크 + embedding_batch 팬아웃."""
    svc = _FakeService(_file(kind="class_material"))
    await split._handle_split(svc, _job())

    chunk_rows = [row for t, rows in svc.inserts if t == "file_chunks"
                  for row in rows]
    assert chunk_rows and all(r["status"] == "pending" for r in chunk_rows)
    job_inserts = [r for t, r in svc.inserts if t == "jobs"]
    assert job_inserts, "embedding_batch 팬아웃이 살아 있어야 한다"
