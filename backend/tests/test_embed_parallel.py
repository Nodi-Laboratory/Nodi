"""D195 — 100개를 넘는 입력은 조각내 **동시에** 보내고, 순서를 지킨다.

`embed_texts`는 워커(청크)·원자화·강의 클립이 모두 쓰는 길목이다. 여기서 조각을
순차로 보내면 그 위의 어떤 병렬화도 이 지점에서 다시 줄을 선다.

⚠️ 순서 보존이 이 파일의 진짜 무게다 — 조각을 완료 순서로 이어붙이면 벡터가
다른 텍스트에 붙고, **어떤 예외도 나지 않는다**(검색이 조금 이상해질 뿐이다).
"""

import asyncio

import pytest

from app.services import upstage


class _FakeResponse:
    def __init__(self, texts: list[str]):
        self._texts = texts
        self.status_code = 200

    def json(self):
        # 벡터 0번 칸에 입력 텍스트의 번호를 심어 짝을 추적한다.
        return {
            "data": [
                {
                    "index": i,
                    "embedding": [float(t)] + [0.0] * (upstage.EMBED_DIM - 1),
                }
                for i, t in enumerate(self._texts)
            ]
        }

    def raise_for_status(self):
        return None


@pytest.mark.asyncio
async def test_조각은_동시에_나가고_순서는_보존된다(monkeypatch):
    live = 0
    peak = 0

    async def fake_post(client, url, **kwargs):
        nonlocal live, peak
        texts = (kwargs.get("json") or {})["input"]
        live += 1
        peak = max(peak, live)
        # 뒤 조각일수록 빨리 끝내 완료 순서를 일부러 뒤집는다.
        await asyncio.sleep(0.03 if texts[0] == "0" else 0.005)
        live -= 1
        return _FakeResponse(texts)

    monkeypatch.setattr(upstage, "_post_with_retry", fake_post)
    monkeypatch.setattr(upstage.settings, "upstage_api_key", "test-key")

    texts = [str(i) for i in range(250)]  # 조각 3개(100/100/50)
    vectors = await upstage.embed_texts(texts, kind="passage")

    assert peak >= 2, f"조각이 순차로 나갔다(최대 동시 {peak})"
    assert len(vectors) == 250
    # L2 정규화 뒤에도 부호·0 여부는 남는다 — 첫 칸으로 짝을 확인한다.
    assert vectors[0][0] == 0.0            # "0"은 정규화해도 0
    for i in range(1, 250):
        assert vectors[i][0] > 0.0, f"{i}번 자리에 다른 조각의 벡터가 왔다"


@pytest.mark.asyncio
async def test_동시성_상한을_지킨다(monkeypatch):
    """concurrency=1이면 조각이 겹치지 않는다(레이트리밋 대응 경로)."""
    live = 0
    peak = 0

    async def fake_post(client, url, **kwargs):
        nonlocal live, peak
        texts = (kwargs.get("json") or {})["input"]
        live += 1
        peak = max(peak, live)
        await asyncio.sleep(0.005)
        live -= 1
        return _FakeResponse(texts)

    monkeypatch.setattr(upstage, "_post_with_retry", fake_post)
    monkeypatch.setattr(upstage.settings, "upstage_api_key", "test-key")

    await upstage.embed_texts([str(i) for i in range(250)], concurrency=1)
    assert peak == 1


@pytest.mark.asyncio
async def test_조각이_하나면_그대로_보낸다(monkeypatch):
    """질의 임베딩(1건)이 가장 흔한 호출 — 세마포어·gather를 태우지 않는다."""
    calls = 0

    async def fake_post(client, url, **kwargs):
        nonlocal calls
        calls += 1
        return _FakeResponse((kwargs.get("json") or {})["input"])

    monkeypatch.setattr(upstage, "_post_with_retry", fake_post)
    monkeypatch.setattr(upstage.settings, "upstage_api_key", "test-key")

    vectors = await upstage.embed_texts(["7"], kind="query")
    assert calls == 1
    assert len(vectors) == 1
