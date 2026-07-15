"""파일 삭제 시 Qdrant 오펀 포인트 정리 테스트 (best-effort).

delete_file은 Storage 객체 + delete_file_cascade RPC(Postgres)만 지우고 Qdrant
벡터를 남겨 오펀이 무한 누적되던 누수를 막는다. 정리는 best-effort — 실패해도
삭제 자체는 성공해야 한다(예외 무전파). 외부 의존(Qdrant 클라이언트)만
monkeypatch하고 Supabase 클라이언트는 최소 대역으로 대체한다.
"""

import pytest

from app.services import files as F
from app.services import qdrant_store

OWNER = "u1"
FILE_ID = "f1"
FILE_ROW = {"owner_id": OWNER, "storage_path": f"{OWNER}/{FILE_ID}/x.pdf"}


class _FakeUserClient:
    """delete_file이 쓰는 최소 UserClient 대역 — files 조회 + RPC 기록."""

    def __init__(self, file_row):
        self._file_row = file_row
        self.rpc_calls = []

    async def select(self, table, params):
        return [self._file_row]  # _assert_file_owner→get_file의 files 조회

    async def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        return None


class _FakeServiceClient:
    def __init__(self):
        self.storage_deletes = []

    async def storage_delete(self, bucket, path):
        self.storage_deletes.append((bucket, path))


class _FakeQdrant:
    """Qdrant AsyncClient의 delete만 흉내 — 호출 기록, 옵션으로 장애 모사."""

    def __init__(self, fail=False):
        self.deletes = []
        self._fail = fail

    async def delete(self, collection_name, points_selector):
        self.deletes.append((collection_name, points_selector))
        if self._fail:
            raise RuntimeError("qdrant down")


def _filter_file_id(points_selector):
    """FilterSelector에서 file_id match 값을 뽑아 필터가 올바른지 확인."""
    return points_selector.filter.must[0].match.value


@pytest.mark.asyncio
async def test_delete_file_purges_qdrant_points(monkeypatch):
    """정상 경로: delete_file이 해당 file_id의 Qdrant 포인트를 정리한다."""
    fake_q = _FakeQdrant()
    monkeypatch.setattr(qdrant_store, "get_client", lambda: fake_q)
    client = _FakeUserClient(FILE_ROW)
    service = _FakeServiceClient()

    await F.delete_file(service, client, OWNER, FILE_ID)

    assert len(fake_q.deletes) == 1
    collection, selector = fake_q.deletes[0]
    assert collection == qdrant_store.COL_FILE_CHUNKS
    assert _filter_file_id(selector) == FILE_ID
    assert ("delete_file_cascade", {"p_file_id": FILE_ID}) in client.rpc_calls


@pytest.mark.asyncio
async def test_qdrant_purge_failure_does_not_block_delete(monkeypatch):
    """정리 실패(Qdrant 장애)가 삭제를 막지 않는다 — 예외 무전파, RPC는 수행."""
    fake_q = _FakeQdrant(fail=True)
    monkeypatch.setattr(qdrant_store, "get_client", lambda: fake_q)
    client = _FakeUserClient(FILE_ROW)
    service = _FakeServiceClient()

    # 예외가 전파되면 이 await에서 테스트가 실패한다.
    await F.delete_file(service, client, OWNER, FILE_ID)

    assert len(fake_q.deletes) == 1  # 정리를 시도는 했고
    assert ("delete_file_cascade", {"p_file_id": FILE_ID}) in client.rpc_calls  # 삭제 완료
