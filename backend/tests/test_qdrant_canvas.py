import pytest

from app.services import qdrant_store


class FakeClient:
    def __init__(self):
        self.scroll_kwargs = None
        self.upsert_points = None

    async def scroll(self, **kwargs):
        self.scroll_kwargs = kwargs
        return ([], None)

    async def upsert(self, collection_name, points):
        self.upsert_points = points


@pytest.mark.asyncio
async def test_scroll_passes_with_vectors_and_filter(monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(qdrant_store, "get_client", lambda: fake)
    await qdrant_store.scroll_canvas_cards("u1", "s1", with_vectors=True)
    assert fake.scroll_kwargs["with_vectors"] is True
    # 필터에 owner_id, session_id 둘 다
    must = fake.scroll_kwargs["scroll_filter"].must
    keys = {m.key for m in must}
    assert {"owner_id", "session_id"} <= keys


@pytest.mark.asyncio
async def test_upsert_includes_size_h(monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(qdrant_store, "get_client", lambda: fake)
    await qdrant_store.upsert_canvas_card(
        "u1", "s1", "n1", 0, "제목", 100.0, 200.0, 320.0, [0.0] * qdrant_store.EMBED_DIM
    )
    p = fake.upsert_points[0]
    assert p.payload["size_h"] == 320.0
    assert p.payload["x"] == 100.0 and p.payload["y"] == 200.0
