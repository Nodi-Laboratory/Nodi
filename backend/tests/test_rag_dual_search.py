"""D116 — rag.dual_search 청크·원자 이중 검색 테스트.

지식 원자화(PIKE-RAG)로 청크 컬렉션(file_chunks)과 원자 질문 컬렉션
(chunk_atoms)을 동시에 검색하고, **게이트를 분리**(직접 히트 0.60 / 원자 히트
0.45)한 뒤 병합·dedupe한다. "청크 벡터로는 멀지만 원자 질문으로는 정확한"
케이스를 살리는 것이 원자화의 목적이므로, 원자 경유 청크에는 청크 게이트를
재적용하지 않는다.

기존 search()는 무수정(레거시 경로 보존) — 이 파일은 dual_search만 검증한다.
외부 의존(임베딩·Qdrant·app_settings 오버레이)은 전부 monkeypatch.
"""

import pytest

from app.services import rag as R


class _FakeClient:
    """테이블별 응답 핸들러를 주입하는 UserClient 대역(class_scope 테스트와 동형)."""

    def __init__(self, responses):
        self.responses = responses  # {table: callable(params) -> rows}
        self.calls = []  # (table, params) 기록 — 재조회 횟수 검증용

    async def select(self, table, params):
        self.calls.append((table, params))
        handler = self.responses.get(table)
        return handler(params) if handler else []


def _patch_infra(monkeypatch, chunk_hits, atom_hits, overlay=None):
    """임베딩·Qdrant(컬렉션별 분기)·오버레이를 고정 응답으로 대체.

    chunk_hits: [{"id": 청크uuid, "score": 유사도, "_file": 파일id}]
    atom_hits:  [{"id": 원자uuid, "score": 유사도, "chunk_id": 소스청크,
                  "_file": 파일id}] — 페이로드 chunk_id로 소스 청크를 잇는다.
    반환된 리스트에 task_type을 누적 — 임베딩 호출 횟수 검증용.
    """
    embed_calls: list[str] = []

    async def fake_embed(texts, task_type):
        embed_calls.append(task_type)
        return [[0.1] * 4]

    async def fake_qdrant_search(collection, vector, k, file_ids=None):
        allowed = set(file_ids or [])
        if collection == R.qdrant_store.COL_CHUNK_ATOMS:
            return [
                {
                    "id": h["id"],
                    "score": h["score"],
                    "payload": {"chunk_id": h["chunk_id"], "file_id": h["_file"]},
                }
                for h in atom_hits
                if h["_file"] in allowed
            ]
        return [
            {"id": h["id"], "score": h["score"], "payload": {"file_id": h["_file"]}}
            for h in chunk_hits
            if h["_file"] in allowed
        ]

    async def fake_overlay():
        return overlay or {}

    monkeypatch.setattr(R.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(R.qdrant_store, "search", fake_qdrant_search)
    monkeypatch.setattr(R.app_settings, "get_overlay", fake_overlay)
    return embed_calls


def _chunk_rows_handler(chunk_ids):
    """file_chunks 재조회 대역 — 주어진 chunk_id만 embedded 행으로 돌려준다."""
    available = {
        cid: {
            "id": cid,
            "file_id": "fm",
            "seq": i,
            "chunk_text": f"본문 {cid}",
        }
        for i, cid in enumerate(chunk_ids)
    }

    def handle(params):
        raw = params.get("id", "")  # "in.(a,b,c)"
        inner = raw[raw.find("(") + 1 : raw.rfind(")")]
        wanted = [c for c in inner.split(",") if c]
        return [available[c] for c in wanted if c in available]

    return handle


@pytest.mark.asyncio
async def test_직접_원자_병합_dedupe(monkeypatch):
    """직접 히트와 원자 경유 히트를 병합하되, 겹치는 청크는 직접 히트가 이긴다."""
    chunk_hits = [
        {"id": "chunk-1", "score": 0.5, "_file": "fm"},   # dist 0.50
        {"id": "chunk-2", "score": 0.45, "_file": "fm"},  # dist 0.55
    ]
    atom_hits = [
        {"id": "atom-a", "score": 0.7, "chunk_id": "chunk-2", "_file": "fm"},  # dist 0.30
        {"id": "atom-b", "score": 0.65, "chunk_id": "chunk-3", "_file": "fm"}, # dist 0.35
    ]
    _patch_infra(monkeypatch, chunk_hits, atom_hits)
    client = _FakeClient(
        {"file_chunks": _chunk_rows_handler(["chunk-1", "chunk-2", "chunk-3"])}
    )
    out = await R.dual_search(client, ["fm"], "질문")
    assert [r["chunk_id"] for r in out] == ["chunk-1", "chunk-2", "chunk-3"]
    assert [r["via"] for r in out] == ["chunk", "chunk", "atom"]
    # chunk-2는 원자 atom-a로도 히트했지만 직접 우선 → via=chunk, 청크 거리 유지.
    assert out[1]["distance"] == pytest.approx(0.55)
    # chunk-3는 원자 경유 → 청크 거리 미상(None), atom_distance만.
    assert out[2]["distance"] is None
    assert out[2]["atom_distance"] == pytest.approx(0.35)


@pytest.mark.asyncio
async def test_게이트_분리(monkeypatch):
    """직접 히트는 0.60, 원자 히트는 원자 거리 0.45로 각각 게이트한다."""
    chunk_hits = [
        {"id": "chunk-x", "score": 0.35, "_file": "fm"},  # dist 0.65 > 0.60 탈락
    ]
    atom_hits = [
        {"id": "atom-y", "score": 0.60, "chunk_id": "chunk-9", "_file": "fm"},  # dist 0.40 통과
    ]
    _patch_infra(monkeypatch, chunk_hits, atom_hits)
    client = _FakeClient({"file_chunks": _chunk_rows_handler(["chunk-9"])})
    out = await R.dual_search(client, ["fm"], "질문")
    assert [r["chunk_id"] for r in out] == ["chunk-9"]
    assert out[0]["via"] == "atom"
    assert out[0]["atom_distance"] == pytest.approx(0.40)


@pytest.mark.asyncio
async def test_원자_게이트_초과는_탈락(monkeypatch):
    """원자 거리가 게이트(0.45)를 넘으면 원자 경유 청크도 탈락한다."""
    atom_hits = [
        {"id": "atom-far", "score": 0.50, "chunk_id": "chunk-far", "_file": "fm"},  # dist 0.50 > 0.45
    ]
    _patch_infra(monkeypatch, [], atom_hits)
    client = _FakeClient({"file_chunks": _chunk_rows_handler(["chunk-far"])})
    out = await R.dual_search(client, ["fm"], "질문")
    assert out == []


@pytest.mark.asyncio
async def test_postgres_재조회는_1회(monkeypatch):
    """직접·원자 chunk_id 합집합을 한 번의 file_chunks select로 재조회한다."""
    chunk_hits = [{"id": "chunk-1", "score": 0.6, "_file": "fm"}]
    atom_hits = [
        {"id": "atom-a", "score": 0.7, "chunk_id": "chunk-2", "_file": "fm"},
    ]
    _patch_infra(monkeypatch, chunk_hits, atom_hits)
    client = _FakeClient(
        {"file_chunks": _chunk_rows_handler(["chunk-1", "chunk-2"])}
    )
    await R.dual_search(client, ["fm"], "질문")
    fc_calls = [c for c in client.calls if c[0] == "file_chunks"]
    assert len(fc_calls) == 1
    # 재조회 필터는 embedded 상태 청크만(기존 search()와 동일 계약).
    assert fc_calls[0][1].get("status") == "eq.embedded"


@pytest.mark.asyncio
async def test_질의_임베딩은_1회_RETRIEVAL_QUERY(monkeypatch):
    """질의 임베딩은 두 컬렉션이 공유 — 딱 한 번, RETRIEVAL_QUERY(비대칭)."""
    chunk_hits = [{"id": "chunk-1", "score": 0.6, "_file": "fm"}]
    embed_calls = _patch_infra(monkeypatch, chunk_hits, [])
    client = _FakeClient({"file_chunks": _chunk_rows_handler(["chunk-1"])})
    await R.dual_search(client, ["fm"], "질문")
    assert embed_calls == ["RETRIEVAL_QUERY"]


@pytest.mark.asyncio
async def test_rls_탈락은_조용히(monkeypatch):
    """원자 경유 chunk_id가 Postgres 재조회에 없으면(RLS/삭제) 조용히 탈락."""
    atom_hits = [
        {"id": "atom-a", "score": 0.7, "chunk_id": "chunk-missing", "_file": "fm"},
    ]
    _patch_infra(monkeypatch, [], atom_hits)
    # 재조회는 chunk-missing을 돌려주지 않는다(available 비어 있음).
    client = _FakeClient({"file_chunks": _chunk_rows_handler([])})
    out = await R.dual_search(client, ["fm"], "질문")
    assert out == []


@pytest.mark.asyncio
async def test_빈_입력은_빈_결과(monkeypatch):
    """file_ids 비었거나 질의 공백이면 검색·재조회 없이 빈 결과."""
    _patch_infra(monkeypatch, [], [])
    client = _FakeClient({})
    assert await R.dual_search(client, [], "질문") == []
    assert await R.dual_search(client, ["fm"], "   ") == []
    assert client.calls == []
