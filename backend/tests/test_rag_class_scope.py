"""D82 — 파일 링크·배치 삭제 후 RAG 학급 자료 자동 스코프 단일 경로 테스트.

링크·제안 엔진 제거로 build_rag_context는 학급 자료(class_material)
자동 스코프 단일 경로가 된다. 학급 세션에서 링크 없이도
class_material을 검색하고, 전 청크에 거리 게이트를 적용하며(무게이트 예외
소멸), 킬 스위치·비학급 공간에서는 아무것도 주입하지 않는지 검증한다.
외부 의존(임베딩·Qdrant·app_settings 오버레이)은 전부 monkeypatch.
"""

import pytest

from app.config import get_settings
from app.services import rag as R


def test_class_material_rag_max_distance_default_is_0_60():
    """거리 게이트 기본값 — E2E 실측(온토픽 0.50~0.56·인사말 0.87) 근거 0.60.
    온토픽 4건 중 3건을 차단하던 회귀 방지."""
    assert get_settings().class_material_rag_max_distance == 0.60


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
    """files 테이블 대역 — class_material 자동 스코프 조회와 _file_names를 구분."""

    def handle(params):
        if params.get("kind") == "eq.class_material":  # 자동 스코프 조회
            return material_rows
        # _file_names 재조회(select=id,name,storage_path) — 이름은 storage 폴백.
        return [
            {
                "id": r["id"],
                "name": None,
                "storage_path": f"o/{r['id']}/{r['id']}.pdf",
            }
            for r in material_rows
        ]

    return handle


def _patch_infra(monkeypatch, hits, overlay=None):
    """임베딩·Qdrant·오버레이를 고정 응답으로 대체.

    hits: [{"id": 청크uuid, "score": 유사도, "_file": 파일id}] — _file은
    파일 스코프 필터 모사용 테스트 전용 키.
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
        }
        for i, h in enumerate(hits)
    ]


@pytest.mark.asyncio
async def test_class_scope_included_without_links(monkeypatch):
    """① 학급 세션이면 링크 없이도 class_material이 검색·주입되고, 참고 블록
    라벨이 '[학급 자료에서 참고]'다(링크 소멸 후 문구 갱신)."""
    hits = [{"id": "ck1", "score": 0.8, "_file": "fm"}]  # distance 0.2 ≤ 0.6
    _patch_infra(monkeypatch, hits)
    client = _FakeClient(
        {
            "files": _files_handler([{"id": "fm"}]),
            "file_chunks": lambda p: _chunk_rows(hits),
        }
    )
    out = await R.build_rag_context(
        client, "질문", space_kind="class", space_ref="c1"
    )
    assert out is not None
    assert [s["file_id"] for s in out["sources"]] == ["fm"]
    assert "본문 ck1" in out["block"]
    assert out["block"].startswith("[학급 자료에서 참고]")


@pytest.mark.asyncio
async def test_distance_gate_applies_to_all_chunks(monkeypatch):
    """② 전 청크 거리 게이트 — 게이트 초과 청크는 탈락, 이내 청크만 주입.
    링크 개념 소멸로 무게이트 예외가 없다."""
    hits = [
        {"id": "ck-far", "score": 0.3, "_file": "fm"},   # dist 0.7 > 0.6 → 탈락
        {"id": "ck-near", "score": 0.8, "_file": "fm"},  # dist 0.2 ≤ 0.6 → 유지
    ]
    _patch_infra(monkeypatch, hits)
    client = _FakeClient(
        {
            "files": _files_handler([{"id": "fm"}]),
            "file_chunks": lambda p: _chunk_rows(hits),
        }
    )
    out = await R.build_rag_context(
        client, "질문", space_kind="class", space_ref="c1"
    )
    assert out is not None
    assert {s["chunk_id"] for s in out["sources"]} == {"ck-near"}


@pytest.mark.asyncio
async def test_kill_switch_off_returns_none(monkeypatch):
    """③ 킬 스위치 off → class_material 조회 자체가 없고 주입도 없다(None)."""
    _patch_infra(
        monkeypatch, hits=[], overlay={"class_material_rag_enabled": False}
    )
    client = _FakeClient({"files": _files_handler([{"id": "fm"}])})
    out = await R.build_rag_context(
        client, "질문", space_kind="class", space_ref="c1"
    )
    assert out is None
    assert all(t != "files" for t, _ in client.calls)  # 자동 스코프 조회 없음


@pytest.mark.asyncio
async def test_personal_space_no_injection(monkeypatch):
    """④ personal 공간 → 자동 스코프 미조회·무주입(None)."""
    _patch_infra(monkeypatch, hits=[])
    client = _FakeClient({"files": _files_handler([{"id": "fm"}])})
    out = await R.build_rag_context(
        client, "질문", space_kind="personal", space_ref="u1"
    )
    assert out is None
    assert all(t != "files" for t, _ in client.calls)
