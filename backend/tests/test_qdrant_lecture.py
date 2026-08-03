"""강의 클립 Qdrant 컬렉션 상수 + search scope_field 일반화 (D149)."""

from app.services import qdrant_store


def test_collection_constant():
    assert qdrant_store.COL_LECTURE_CLIPS == "lecture_clips"
    assert qdrant_store.COL_LECTURE_CLIP_ATOMS == "lecture_clip_atoms"


def test_search_has_scope_field_param():
    import inspect

    sig = inspect.signature(qdrant_store.search)
    assert "scope_field" in sig.parameters
    assert sig.parameters["scope_field"].default == "file_id"
