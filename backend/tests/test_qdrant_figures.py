"""textbook_figures 컬렉션 보장 테스트 (TASK 4, D86~D88).

경량: qdrant_store의 상수/컬렉션 보장만 검증(런타임 무변경 기반 task).
마이그레이션 SQL은 단위 테스트 불가 — DoD의 TDD 예외(정리·선언형).
"""

from qdrant_client import models

from app.services import qdrant_store


class FakeClient:
    """ensure_collections 호출 추적용 페이크 — 모든 컬렉션이 '없음'이라 생성 유도."""

    def __init__(self):
        self.created_collections: list[str] = []
        self.payload_indexes: list[tuple[str, str, object]] = []

    async def collection_exists(self, name):
        return False

    async def create_collection(self, collection_name, vectors_config):
        self.created_collections.append(collection_name)

    async def create_payload_index(self, collection_name, field_name, field_schema):
        self.payload_indexes.append((collection_name, field_name, field_schema))


def test_col_textbook_figures_constant():
    assert qdrant_store.COL_TEXTBOOK_FIGURES == "textbook_figures"


async def test_ensure_collections_creates_textbook_figures(monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(qdrant_store, "get_client", lambda: fake)

    await qdrant_store.ensure_collections()

    # 컬렉션 생성 시도.
    assert "textbook_figures" in fake.created_collections
    # file_id KEYWORD 페이로드 인덱스 등록 시도(file_chunks와 동형).
    assert (
        "textbook_figures",
        "file_id",
        models.PayloadSchemaType.KEYWORD,
    ) in fake.payload_indexes
