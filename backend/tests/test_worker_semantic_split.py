"""D132 — 워커 split 의미 청킹 분기 테스트.

`semantic_chunking_enabled` on이고 세션 업로드가 아니며 문서가 크기 가드
이내일 때만 `semantic_chunker.chunk_text_semantic`을 부른다. 그 외(off·
user_upload·크기 초과)는 기존 정규식 `embedding.chunk_text` 경로 그대로.
의미 청킹이 어떤 이유로 실패해도 정규식 폴백으로 인덱싱은 계속된다
(파일 failed 아님 — 인덱싱 불가침).

monkeypatch는 모듈 한정 호출 규약: `split.semantic_chunker.chunk_text_semantic`.
"""

import pytest

from app.services import app_settings, embedding
from app.services.worker import common, split


class _FakeService:
    def __init__(self, file_row):
        self.file_row = file_row
        self.inserts = []
        self.updates = []
        self.deletes = []

    async def select(self, table, params):
        if table == "files" and "id" in params:
            return [dict(self.file_row)]
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


def _file(kind="class_material", session_id=None):
    return {
        "id": "f1", "owner_id": "u1", "storage_path": "u1/f1/a.txt",
        "mime": "text/plain", "space_ref": None,
        "kind": kind, "session_id": session_id,
    }


def _job():
    return {"id": "j1", "kind": "embedding_split", "target_id": "f1"}


@pytest.fixture
def patch_env(monkeypatch):
    """추출 텍스트·오버레이·Qdrant 정리를 테스트별로 주입할 수 있게 한다."""

    def _apply(*, text="가" * 3000, overlay=None):
        async def fake_extract(data, mime, path):
            return text

        async def fake_qdrant_delete(file_id, collection=None):
            return None

        async def fake_overlay():
            return overlay or {}

        monkeypatch.setattr(common, "_extract_text", fake_extract)
        monkeypatch.setattr(common, "_qdrant_delete_file_points", fake_qdrant_delete)
        monkeypatch.setattr(app_settings, "get_overlay", fake_overlay)

    return _apply


def _spy_semantic(monkeypatch, result=None, raises=False):
    """split.semantic_chunker.chunk_text_semantic를 기록 fake로 대체."""
    calls = []

    async def fake_semantic(text, size, overlap, *, heartbeat=None):
        calls.append({"text": text, "size": size, "overlap": overlap,
                      "heartbeat": heartbeat})
        if raises:
            raise RuntimeError("의미 청킹 폭발")
        return result if result is not None else ["의미청크"]

    monkeypatch.setattr(split.semantic_chunker, "chunk_text_semantic", fake_semantic)
    return calls


@pytest.mark.asyncio
async def test_semantic_on_small_doc_calls_chunker(patch_env, monkeypatch):
    """① 노브 on + 소형 문서 → chunk_text_semantic 호출 + 그 결과가 청크가 된다."""
    patch_env(text="가" * 3000, overlay={"semantic_chunking_enabled": True})
    calls = _spy_semantic(monkeypatch, result=["sem-a", "sem-b"])

    svc = _FakeService(_file())
    await split._handle_split(svc, _job())

    assert len(calls) == 1, "의미 청킹이 정확히 한 번 호출되어야 한다"
    assert callable(calls[0]["heartbeat"]), "하트비트 콜백이 전달되어야 한다"
    chunk_rows = [row for t, rows in svc.inserts if t == "file_chunks"
                  for row in rows]
    assert [r["chunk_text"] for r in chunk_rows] == ["sem-a", "sem-b"]


@pytest.mark.asyncio
async def test_semantic_off_uses_regex(patch_env, monkeypatch):
    """② 노브 off → chunk_text_semantic 미호출 + embedding.chunk_text 결과 그대로."""
    patch_env(text="가" * 3000, overlay={})  # 기본 off
    calls = _spy_semantic(monkeypatch)

    expected = embedding.chunk_text("가" * 3000, 1200, 150)

    svc = _FakeService(_file())
    await split._handle_split(svc, _job())

    assert calls == [], "off면 의미 청킹을 부르면 안 된다"
    chunk_rows = [row for t, rows in svc.inserts if t == "file_chunks"
                  for row in rows]
    assert [r["chunk_text"] for r in chunk_rows] == expected


@pytest.mark.asyncio
async def test_user_upload_skips_semantic(patch_env, monkeypatch):
    """③ user_upload는 노브 on이어도 의미 청킹 미호출(세션 전문 주입용)."""
    patch_env(text="가" * 3000, overlay={"semantic_chunking_enabled": True})
    calls = _spy_semantic(monkeypatch)

    svc = _FakeService(_file(kind="user_upload"))
    await split._handle_split(svc, _job())

    assert calls == [], "user_upload는 의미 청킹을 부르면 안 된다"
    assert any(t == "file_chunks" for t, _ in svc.inserts)


@pytest.mark.asyncio
async def test_oversized_doc_skips_semantic(patch_env, monkeypatch):
    """④ len(text) > semantic_chunking_max_chars → 의미 청킹 미호출(정규식 폴백)."""
    patch_env(
        text="가" * 20_000,
        overlay={"semantic_chunking_enabled": True,
                 "semantic_chunking_max_chars": 10_000},
    )
    calls = _spy_semantic(monkeypatch)

    svc = _FakeService(_file())
    await split._handle_split(svc, _job())

    assert calls == [], "크기 가드 초과 문서는 의미 청킹을 부르면 안 된다"
    assert any(t == "file_chunks" for t, _ in svc.inserts)


@pytest.mark.asyncio
async def test_semantic_exception_falls_back_to_regex(patch_env, monkeypatch):
    """⑤ 의미 청킹 예외 → 정규식 폴백으로 청크 산출 + 파일 failed 아님."""
    patch_env(text="가" * 3000, overlay={"semantic_chunking_enabled": True})
    calls = _spy_semantic(monkeypatch, raises=True)

    expected = embedding.chunk_text("가" * 3000, 1200, 150)

    svc = _FakeService(_file())
    await split._handle_split(svc, _job())

    assert len(calls) == 1, "예외 나기 전 한 번은 호출된다"
    chunk_rows = [row for t, rows in svc.inserts if t == "file_chunks"
                  for row in rows]
    assert [r["chunk_text"] for r in chunk_rows] == expected
    files_updates = [v for t, _, v in svc.updates if t == "files"]
    assert all(v.get("status") != "failed" for v in files_updates), \
        "의미 청킹 실패가 파일을 failed로 만들면 안 된다"
