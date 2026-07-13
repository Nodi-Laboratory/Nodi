import pytest

from app.services import rag


def _hit(score, text, name="중학 과학 2", page=None, seq=0):
    payload = {
        "chunk_text": text,
        "source_name": name,
        "subject": "과학",
        "grade": "중2",
        "seq": seq,
    }
    if page is not None:
        payload["page"] = page
    return {"id": f"pt-{seq}", "score": score, "payload": payload}


@pytest.fixture
def overlay(monkeypatch):
    """app_settings 오버레이를 빈 dict로 고정(설정은 config 기본값으로)."""
    data = {}

    async def fake_overlay():
        return data

    monkeypatch.setattr(rag.app_settings, "get_overlay", fake_overlay)
    return data


@pytest.mark.asyncio
async def test_gate_pass_builds_block_and_sources(overlay, monkeypatch):
    async def fake_search(collection, vector, k, **kw):
        assert collection == rag.qdrant_store.COL_TEXTBOOK
        assert k == 4  # config 기본 textbook_rag_top_k
        return [_hit(0.9, "광합성은 빛에너지로 양분을 만드는 과정", page=12, seq=3)]

    monkeypatch.setattr(rag.qdrant_store, "search", fake_search)
    out = await rag.build_textbook_context([0.1] * 4)
    assert out is not None
    lines = out["block"].splitlines()
    assert lines[0] == "[교과서에서 참고]"
    # page가 있으면 p.N 라벨 (seq 미표기)
    assert "[중학 과학 2 · p.12]" in lines[1]
    src = out["sources"][0]
    assert src["name"] == "중학 과학 2"
    assert src["page"] == 12
    assert src["seq"] == 3
    assert abs(src["distance"] - 0.1) < 1e-9  # 1 - 0.9
    assert src["snippet"].startswith("광합성")


@pytest.mark.asyncio
async def test_label_falls_back_to_seq_without_page(overlay, monkeypatch):
    async def fake_search(*a, **k):
        return [_hit(0.9, "본문", page=None, seq=7)]

    monkeypatch.setattr(rag.qdrant_store, "search", fake_search)
    out = await rag.build_textbook_context([0.1] * 4)
    assert "[중학 과학 2 · #7]" in out["block"]


@pytest.mark.asyncio
async def test_all_gated_out_returns_none(overlay, monkeypatch):
    async def fake_search(*a, **k):
        # distance = 1 - 0.3 = 0.7 > 기본 게이트 0.45 → 탈락
        return [_hit(0.3, "관련 없는 청크")]

    monkeypatch.setattr(rag.qdrant_store, "search", fake_search)
    assert await rag.build_textbook_context([0.1] * 4) is None


@pytest.mark.asyncio
async def test_empty_vector_returns_none(overlay):
    assert await rag.build_textbook_context([]) is None


@pytest.mark.asyncio
async def test_qdrant_error_returns_none(overlay, monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("qdrant down")

    monkeypatch.setattr(rag.qdrant_store, "search", boom)
    # 불변식: 검색 실패는 None으로 강등될 뿐 raise하지 않는다
    assert await rag.build_textbook_context([0.1] * 4) is None


@pytest.mark.asyncio
async def test_disabled_via_overlay_skips_search(overlay, monkeypatch):
    overlay["textbook_rag_enabled"] = False
    called = {"n": 0}

    async def fake_search(*a, **k):
        called["n"] += 1
        return []

    monkeypatch.setattr(rag.qdrant_store, "search", fake_search)
    assert await rag.build_textbook_context([0.1] * 4) is None
    assert called["n"] == 0  # 비활성 시 Qdrant 왕복 자체가 없어야 한다


@pytest.mark.asyncio
async def test_overlay_overrides_gate(overlay, monkeypatch):
    overlay["textbook_rag_max_distance"] = 0.8

    async def fake_search(*a, **k):
        return [_hit(0.3, "느슨한 게이트로 통과")]  # distance 0.7 <= 0.8

    monkeypatch.setattr(rag.qdrant_store, "search", fake_search)
    out = await rag.build_textbook_context([0.1] * 4)
    assert out is not None and "느슨한 게이트로 통과" in out["block"]
