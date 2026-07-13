import uuid

from app.services import qdrant_store


def test_textbook_point_id_deterministic_and_distinct():
    a = qdrant_store.textbook_point_id("중학 과학 2", 0)
    # 같은 입력 → 같은 id (재실행 ingest가 덮어쓰는 규약)
    assert a == qdrant_store.textbook_point_id("중학 과학 2", 0)
    # seq / source_name이 다르면 다른 id
    assert a != qdrant_store.textbook_point_id("중학 과학 2", 1)
    assert a != qdrant_store.textbook_point_id("국어 1", 0)
    # 유효한 uuid 문자열 (Qdrant 포인트 id 요건)
    uuid.UUID(a)


def test_textbook_collection_constant():
    assert qdrant_store.COL_TEXTBOOK == "textbook"
