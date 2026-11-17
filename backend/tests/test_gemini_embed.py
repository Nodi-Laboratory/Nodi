"""Gemini 임베딩(2026-11-17) — 요청 모양 · 정규화 · 배치 순서 · 429 재시도 · 키 비노출.

전부 httpx.MockTransport라 키·네트워크가 필요 없다. 지키는 것:

  · taskType이 질의/문서로 갈린다(비대칭 불변식) + `outputDimensionality`가 실린다.
  · **응답이 정규화돼 있지 않다**(1024d 노름 0.6165, 실측) — 안 나누면 거리 게이트가
    통째로 틀어진다. 반환은 단위 벡터여야 한다.
  · 100개 단위로 쪼개 동시에 보내도 **입력 순서대로** 돌아온다(어긋나면 예외 없이
    벡터가 다른 텍스트에 붙는다).
  · 429는 기다렸다 다시 시도하고, 키는 URL·로그·예외 문장 어디에도 없다.
"""

from __future__ import annotations

import asyncio
import logging

import httpx
import pytest

from app.services import api_keys, gemini_embed, upstage

KEY = "AIza-test-secret-key-0123456789"


@pytest.fixture(autouse=True)
def _gemini_key(monkeypatch):
    monkeypatch.setattr(gemini_embed.settings, "gemini_api_key", KEY)


def _install(monkeypatch, handler) -> None:
    """gemini_embed가 만드는 AsyncClient에 MockTransport를 끼운다."""
    real = httpx.AsyncClient

    def factory(**kw):
        return real(transport=httpx.MockTransport(handler), **kw)

    monkeypatch.setattr(gemini_embed.httpx, "AsyncClient", factory)


def _body(request: httpx.Request) -> dict:
    import json

    return json.loads(request.content)


def _ok(n: int, *, first: float = 0.6165, dim: int = gemini_embed.EMBED_DIM) -> httpx.Response:
    """정규화되지 않은(노름 `first`) 임베딩 n개 — Gemini 1024d 응답을 흉내 낸다."""
    vec = [first] + [0.0] * (dim - 1)
    return httpx.Response(200, json={"embeddings": [{"values": vec} for _ in range(n)]})


def test_차원_계약이_upstage와_같다():
    # 두 값이 갈라지면 Qdrant 컬렉션(1024d)에 제공자별로 다른 크기가 들어간다.
    assert gemini_embed.EMBED_DIM == upstage.EMBED_DIM == 1024
    assert gemini_embed.EMBED_MAX_BATCH == upstage.EMBED_MAX_BATCH == 100


async def test_요청_모양_taskType과_차원과_키_헤더(monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return _ok(len(_body(request)["requests"]))

    _install(monkeypatch, handler)
    await gemini_embed.embed_texts(["광합성", "기공"], kind="passage")
    await gemini_embed.embed_texts(["광합성이 뭐야?"], kind="query")

    doc, qry = seen
    assert doc.url.path.endswith("/models/gemini-embedding-001:batchEmbedContents")
    reqs = _body(doc)["requests"]
    assert [r["content"]["parts"][0]["text"] for r in reqs] == ["광합성", "기공"]
    assert {r["taskType"] for r in reqs} == {"RETRIEVAL_DOCUMENT"}
    assert {r["outputDimensionality"] for r in reqs} == {1024}
    assert {r["model"] for r in reqs} == {"models/gemini-embedding-001"}
    # 비대칭 — 질의는 다른 taskType이다.
    assert {r["taskType"] for r in _body(qry)["requests"]} == {"RETRIEVAL_QUERY"}
    # 키는 헤더로만 간다 — URL(쿼리)에 있으면 httpx 오류·접근 로그에 그대로 남는다.
    assert doc.headers["x-goog-api-key"] == KEY
    assert KEY not in str(doc.url) and "key=" not in str(doc.url)


async def test_반환은_L2_정규화된다(monkeypatch):
    _install(monkeypatch, lambda r: _ok(len(_body(r)["requests"])))  # 노름 0.6165
    [vec] = await gemini_embed.embed_texts(["광합성"], kind="passage")
    assert len(vec) == 1024
    assert abs(sum(x * x for x in vec) - 1.0) < 1e-9
    assert abs(vec[0] - 1.0) < 1e-9


async def test_차원이_다르면_즉시_실패한다(monkeypatch):
    # outputDimensionality가 무시돼 3072가 오는 회귀를 조용히 넘기지 않는다.
    _install(monkeypatch, lambda r: _ok(len(_body(r)["requests"]), dim=3072))
    with pytest.raises(RuntimeError, match="기대 차원"):
        await gemini_embed.embed_texts(["광합성"], kind="passage")


async def test_응답_개수가_다르면_실패한다(monkeypatch):
    _install(monkeypatch, lambda r: _ok(1))
    with pytest.raises(RuntimeError, match="개 입력에"):
        await gemini_embed.embed_texts(["a", "b"], kind="passage")


async def test_배치는_100개씩_쪼개고_순서를_지킨다(monkeypatch):
    sizes: list[int] = []
    live = peak = 0

    async def handler(request):
        nonlocal live, peak
        texts = [r["content"]["parts"][0]["text"] for r in _body(request)["requests"]]
        sizes.append(len(texts))
        live += 1
        peak = max(peak, live)
        # 앞 조각일수록 늦게 끝내 완료 순서를 일부러 뒤집는다.
        await asyncio.sleep(0.03 if texts[0] == "0" else 0.005)
        live -= 1
        return httpx.Response(
            200,
            json={"embeddings": [{"values": [float(t)] + [0.0] * 1023} for t in texts]},
        )

    _install(monkeypatch, handler)
    vectors = await gemini_embed.embed_texts([str(i) for i in range(250)], kind="passage")

    assert sorted(sizes) == [50, 100, 100]
    assert peak >= 2, "조각이 순차로 나갔다"
    assert len(vectors) == 250
    assert vectors[0][0] == 0.0
    # 정규화 뒤에도 부호·0 여부는 남는다 — 각 자리가 자기 텍스트의 벡터인지 본다.
    for i in range(1, 250):
        assert vectors[i][0] > 0.0, f"{i}번 자리에 다른 조각의 벡터가 왔다"


async def test_빈_입력은_호출하지_않는다(monkeypatch):
    def handler(request):  # pragma: no cover - 호출되면 실패
        raise AssertionError("빈 입력에 API를 부르면 안 된다")

    _install(monkeypatch, handler)
    assert await gemini_embed.embed_texts([]) == []


async def test_알_수_없는_kind는_거절한다():
    with pytest.raises(ValueError, match="unknown embedding kind"):
        await gemini_embed.embed_texts(["a"], kind="doc")


async def test_빈_문자열은_공백으로_바꿔_보낸다(monkeypatch):
    sent: list[str] = []

    def handler(request):
        reqs = _body(request)["requests"]
        sent.extend(r["content"]["parts"][0]["text"] for r in reqs)
        return _ok(len(reqs))

    _install(monkeypatch, handler)
    await gemini_embed.embed_texts(["", "x" * 10_000], kind="passage")
    assert sent[0] == " "
    assert len(sent[1]) == gemini_embed._MAX_CHARS  # 토큰 한도 아래로 방어적 절단


# ── 429 재시도 ─────────────────────────────────────────────────────
@pytest.fixture
def waits(monkeypatch):
    """asyncio.sleep을 기록만 하고 즉시 돌려준다(진짜 sleep은 한 틱만)."""
    real_sleep = asyncio.sleep
    log: list[float] = []

    async def fake(seconds, *a, **k):
        log.append(seconds)
        await real_sleep(0)

    monkeypatch.setattr(gemini_embed.asyncio, "sleep", fake)
    return log


async def test_429는_기다렸다_다시_시도한다(monkeypatch, waits):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        if calls <= 2:
            return httpx.Response(429, json={"error": {"status": "RESOURCE_EXHAUSTED"}})
        return _ok(len(_body(request)["requests"]))

    _install(monkeypatch, handler)
    [vec] = await gemini_embed.embed_texts(["광합성"], kind="query")
    assert calls == 3
    assert waits == [1.0, 2.0]  # 지수 백오프
    assert len(vec) == 1024


async def test_Retry_After와_retryDelay를_존중한다(monkeypatch, waits):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, headers={"Retry-After": "7"}, json={})
        if calls == 2:
            body = '{"error":{"details":[{"retryDelay":"12s"}]}}'
            return httpx.Response(429, content=body)
        return _ok(1)

    _install(monkeypatch, handler)
    await gemini_embed.embed_texts(["a"], kind="query")
    assert waits == [7.0, 12.0]


def test_대기는_상한을_넘지_않는다():
    resp = httpx.Response(429, headers={"Retry-After": "3600"})
    assert gemini_embed._retry_wait(resp, 1.0) == gemini_embed._MAX_WAIT_S


async def test_5xx와_전송오류도_재시도한다(monkeypatch, waits):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(503)
        if calls == 2:
            raise httpx.ConnectError("boom")
        return _ok(1)

    _install(monkeypatch, handler)
    await gemini_embed.embed_texts(["a"], kind="query")
    assert calls == 3


async def test_4xx는_재시도하지_않는다(monkeypatch, waits):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(400, json={"error": {"message": "bad"}})

    _install(monkeypatch, handler)
    with pytest.raises(httpx.HTTPStatusError):
        await gemini_embed.embed_texts(["a"], kind="query")
    assert calls == 1
    assert waits == []


async def test_끝내_429면_예외이고_키는_어디에도_없다(monkeypatch, waits, caplog):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(429, json={})

    _install(monkeypatch, handler)
    with caplog.at_level(logging.DEBUG, logger="nodi.gemini_embed"):
        with pytest.raises(httpx.HTTPStatusError) as err:
            await gemini_embed.embed_texts(["비밀 질문"], kind="query")
    assert calls == gemini_embed._MAX_RETRIES
    # 예외 문장·로그 어디에도 키(와 사용자 텍스트)가 없다.
    assert KEY not in str(err.value)
    assert KEY not in caplog.text
    assert "비밀 질문" not in caplog.text
    assert "429" in caplog.text  # 상태 코드는 남긴다


# ── 키 해석 ─────────────────────────────────────────────────────────
async def test_키가_없으면_업스테이지와_같은_종류의_예외(monkeypatch):
    monkeypatch.setattr(gemini_embed.settings, "gemini_api_key", "")

    def handler(request):  # pragma: no cover
        raise AssertionError("키 없이 호출하면 안 된다")

    _install(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY is not configured"):
        await gemini_embed.embed_texts(["a"], kind="query")


async def test_env_키가_없으면_요청_헤더_키를_쓴다(monkeypatch):
    """질의는 요청 범위라 헤더 키가 닿는다(워커는 env만 본다)."""
    monkeypatch.setattr(gemini_embed.settings, "gemini_api_key", "")
    seen: list[str] = []

    def handler(request):
        seen.append(request.headers["x-goog-api-key"])
        return _ok(1)

    _install(monkeypatch, handler)
    token = api_keys._gemini_key.set("header-key-xyz")
    try:
        await gemini_embed.embed_texts(["a"], kind="query")
    finally:
        api_keys._gemini_key.reset(token)
    assert seen == ["header-key-xyz"]
