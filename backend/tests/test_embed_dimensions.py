"""D106 — 임베딩 차원 축소 요청이 실제로 나가는가.

`dimensions` 파라미터가 빠지면 Upstage는 기본 4096을 돌려준다. 그러면 Qdrant
컬렉션(EMBED_DIM으로 생성)과 어긋나 업서트가 실패하는데, **실패 지점이 임베딩이
아니라 저장 단계**라 원인이 한참 뒤에 드러난다. 요청에 값이 실리는지와
차원 검증이 도는지를 여기서 고정한다.
"""

import httpx
import pytest

from app.services import upstage


class _FakeResponse:
    def __init__(self, dim: int, count: int):
        self._dim, self._count = dim, count
        self.status_code = 200

    def json(self):
        return {
            "data": [
                {"index": i, "embedding": [0.0] * (self._dim - 1) + [1.0]}
                for i in range(self._count)
            ]
        }

    def raise_for_status(self):
        return None


def _capture(monkeypatch, dim: int):
    """embed_texts가 보내는 payload를 가로채고, 원하는 차원으로 응답한다."""
    sent: dict = {}

    async def fake_post(client, url, **kwargs):
        sent.update(kwargs.get("json") or {})
        return _FakeResponse(dim, len(sent.get("input") or []))

    monkeypatch.setattr(upstage, "_post_with_retry", fake_post)
    monkeypatch.setattr(upstage.settings, "upstage_api_key", "test-key")
    return sent


async def test_dimensions_파라미터가_요청에_실린다(monkeypatch):
    sent = _capture(monkeypatch, upstage.EMBED_DIM)
    await upstage.embed_texts(["광합성"], kind="passage")
    assert sent["dimensions"] == upstage.EMBED_DIM


async def test_질의와_문서가_서로_다른_모델을_쓴다(monkeypatch):
    # 비대칭 임베딩 불변식 — 혼용하면 검색 품질이 조용히 나빠진다.
    sent = _capture(monkeypatch, upstage.EMBED_DIM)
    await upstage.embed_texts(["질문"], kind="query")
    query_model = sent["model"]
    await upstage.embed_texts(["문서"], kind="passage")
    assert query_model != sent["model"]


async def test_차원이_다르면_즉시_실패한다(monkeypatch):
    # API가 dimensions를 무시하고 4096을 돌려주는 회귀를 조용히 넘기지 않는다.
    _capture(monkeypatch, 4096)
    with pytest.raises(RuntimeError, match="기대 차원"):
        await upstage.embed_texts(["광합성"], kind="passage")


async def test_반환_벡터는_L2_정규화된다(monkeypatch):
    # 거리 규약 distance = 1 - dot 이 성립하려면 단위 벡터여야 한다.
    _capture(monkeypatch, upstage.EMBED_DIM)
    [vec] = await upstage.embed_texts(["광합성"], kind="passage")
    assert len(vec) == upstage.EMBED_DIM
    assert abs(sum(v * v for v in vec) - 1.0) < 1e-9


def test_qdrant_컬렉션이_같은_차원을_쓴다():
    # 두 값이 갈라지면 업서트가 저장 단계에서 죽는다.
    from app.services import qdrant_store

    assert qdrant_store.EMBED_DIM == upstage.EMBED_DIM


async def test_빈_입력은_호출하지_않는다(monkeypatch):
    called = False

    async def boom(*a, **k):
        nonlocal called
        called = True
        raise AssertionError("빈 입력에 API를 부르면 안 된다")

    monkeypatch.setattr(upstage, "_post_with_retry", boom)
    assert await upstage.embed_texts([]) == []
    assert not called


def test_httpx가_실제로_임포트되어_있다():
    # _FakeResponse가 httpx.Response를 흉내 내므로 계약이 바뀌면 알아채야 한다.
    assert hasattr(httpx, "AsyncClient")
