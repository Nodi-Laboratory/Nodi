"""D73 — 학급 자료(class_material) 자동 RAG 스코프 주입 테스트.

build_rag_context가 학급 세션에서 링크 없이도 class_material을 검색 후보에
넣고, 자동 스코프(비링크) 청크에만 거리 게이트를 적용하는지 검증한다.
외부 의존(임베딩·Qdrant·app_settings 오버레이)은 전부 monkeypatch.
"""

import pytest

from app.services import rag as R


class _FakeClient:
    """테이블별 응답 핸들러를 주입하는 UserClient 대역."""

    def __init__(self, responses):
        self.responses = responses  # {table: callable(params) -> rows}
        self.calls = []  # (table, params) 기록 — 쿼리 발생 여부 검증용

    async def select(self, table, params):
        self.calls.append((table, params))
        handler = self.responses.get(table)
        return handler(params) if handler else []


def _files_handler(material_rows):
    """files 테이블 대역 — class_material 조회와 _file_names 조회를 구분."""

    def handle(params):
        if params.get("select") == "id,storage_path":  # _file_names
            return [
                {"id": r["id"], "storage_path": f"o/{r['id']}/{r['id']}.pdf"}
                for r in material_rows
            ]
        if params.get("kind") == "eq.class_material":  # 자동 스코프 조회
            return material_rows
        return []

    return handle


def _patch_infra(monkeypatch, hits, overlay=None):
    """임베딩·Qdrant·오버레이를 고정 응답으로 대체.

    hits: [{"id": 청크uuid, "score": 유사도, "_file": 파일id}] — _file은
    파일 스코프 필터 모사용 테스트 전용 키(반환 시 제거).
    """

    async def fake_embed(texts, task_type):
        assert task_type == "RETRIEVAL_QUERY"  # 비대칭 임베딩 불변식
        return [[0.1] * 4]

    async def fake_qdrant_search(collection, vector, k, file_ids=None):
        allowed = set(file_ids or [])
        return [
            {"id": h["id"], "score": h["score"]}
            for h in hits
            if h["_file"] in allowed
        ]

    async def fake_overlay():
        return overlay or {}

    monkeypatch.setattr(R.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(R.qdrant_store, "search", fake_qdrant_search)
    monkeypatch.setattr(R.app_settings, "get_overlay", fake_overlay)


def _chunk_rows(hits):
    return [
        {
            "id": h["id"],
            "file_id": h["_file"],
            "seq": i,
            "chunk_text": f"본문 {h['id']}",
            "meta": {},
        }
        for i, h in enumerate(hits)
    ]


CHAIN = [{"id": "n1"}]


@pytest.mark.asyncio
async def test_class_scope_included_without_links(monkeypatch):
    """① 링크 0개여도 학급 세션이면 class_material이 검색·주입된다."""
    hits = [{"id": "ck1", "score": 0.8, "_file": "fm"}]  # distance 0.2 ≤ 0.5
    _patch_infra(monkeypatch, hits)
    client = _FakeClient(
        {
            "file_node_links": lambda p: [],
            "files": _files_handler([{"id": "fm"}]),
            "file_chunks": lambda p: _chunk_rows(hits),
        }
    )
    out = await R.build_rag_context(
        client, CHAIN, "질문", space_kind="class", space_ref="c1"
    )
    assert out is not None
    assert [s["file_id"] for s in out["sources"]] == ["fm"]
    assert "본문 ck1" in out["block"]


@pytest.mark.asyncio
async def test_distance_gate_applies_to_auto_scope_only(monkeypatch):
    """② 자동 스코프 청크만 거리 게이트 — 링크 청크는 무게이트."""
    hits = [
        {"id": "ck-linked", "score": 0.3, "_file": "fl"},  # 링크, dist 0.7 → 유지
        {"id": "ck-auto-far", "score": 0.3, "_file": "fm"},  # 자동, dist 0.7 → 탈락
        {"id": "ck-auto-near", "score": 0.8, "_file": "fm"},  # 자동, dist 0.2 → 유지
    ]
    _patch_infra(monkeypatch, hits)

    def files_handle(params):
        if params.get("select") == "id,storage_path":
            return [
                {"id": "fl", "storage_path": "o/fl/linked.pdf"},
                {"id": "fm", "storage_path": "o/fm/material.pdf"},
            ]
        if params.get("kind") == "eq.class_material":
            return [{"id": "fm"}]
        return []

    client = _FakeClient(
        {
            "file_node_links": lambda p: [{"file_id": "fl"}],
            "files": files_handle,
            "file_chunks": lambda p: _chunk_rows(hits),
        }
    )
    out = await R.build_rag_context(
        client, CHAIN, "질문", space_kind="class", space_ref="c1"
    )
    assert out is not None
    ids = {s["chunk_id"] for s in out["sources"]}
    assert ids == {"ck-linked", "ck-auto-near"}


@pytest.mark.asyncio
async def test_kill_switch_off_restores_linked_only(monkeypatch):
    """③ 킬 스위치 off → class_material 조회 자체가 없고 링크 없으면 None."""
    _patch_infra(
        monkeypatch, hits=[], overlay={"class_material_rag_enabled": False}
    )
    client = _FakeClient(
        {"file_node_links": lambda p: [], "files": _files_handler([{"id": "fm"}])}
    )
    out = await R.build_rag_context(
        client, CHAIN, "질문", space_kind="class", space_ref="c1"
    )
    assert out is None
    assert all(t != "files" for t, _ in client.calls)  # 자동 스코프 조회 없음


@pytest.mark.asyncio
async def test_personal_space_unchanged(monkeypatch):
    """④ personal 공간 → 기존 동작 불변(자동 스코프 미조회, 링크 없으면 None)."""
    _patch_infra(monkeypatch, hits=[])
    client = _FakeClient({"file_node_links": lambda p: []})
    out = await R.build_rag_context(
        client, CHAIN, "질문", space_kind="personal", space_ref="u1"
    )
    assert out is None
    assert all(t != "files" for t, _ in client.calls)


@pytest.mark.asyncio
async def test_signature_backward_compatible(monkeypatch):
    """kwargs 없이 호출해도 기존 링크-온리 동작(무회귀)."""
    _patch_infra(monkeypatch, hits=[])
    client = _FakeClient({"file_node_links": lambda p: []})
    out = await R.build_rag_context(client, CHAIN, "질문")
    assert out is None
