"""홈 개념 지도 (D189).

고정하는 계약:
  1. **Qdrant는 신뢰 경계가 아니다** — 벡터 저장소가 준 id 중 RLS로 확인된
     카드에 없는 것은 버린다. 이게 깨지면 남의 개념이 내 지도에 뜬다.
  2. 먼 쌍은 선을 안 긋는다 — 게이트가 없으면 지도가 한 덩어리가 된다.
  3. AI 개념 카드만 묻는다 — 메모는 임베딩이 없어 의미로 못 묶는다.
  4. 카드가 없으면 Qdrant를 아예 안 부른다.
  5. 지도가 못 그려져도(벡터 조회 실패) **노드는 나온다** — 선만 없다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.services import home

aio = pytest.mark.asyncio

MINE_A = "11111111-1111-4111-8111-111111111111"
MINE_B = "22222222-2222-4222-8222-222222222222"
STRANGER = "99999999-9999-4999-8999-999999999999"


class FakeClient:
    def __init__(self, items: list[dict] | None = None):
        self.items = items if items is not None else [
            {"id": MINE_A, "session_id": "s1", "title": "광합성", "body": "본문",
             "tag": "생명", "created_at": "2026-08-06T00:00:00Z"},
            {"id": MINE_B, "session_id": "s1", "title": "빛", "body": "본문",
             "tag": "물리", "created_at": "2026-08-06T00:00:00Z"},
        ]
        self.params: list[dict] = []

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        self.params.append({"table": table, **params})
        if table == "canvas_items":
            return self.items
        if table == "sessions":
            return [{"id": "s1", "title": "빛 이야기", "space_kind": "personal",
                     "space_ref": None, "updated_at": "2026-08-06T00:00:00Z"}]
        return []


def _patch_pairs(monkeypatch, pairs, *, boom: bool = False):
    from app.services import qdrant_store

    async def fake(owner_id, *, sample, neighbors):
        if boom:
            raise RuntimeError("Qdrant 죽음")
        return pairs

    monkeypatch.setattr(qdrant_store, "concept_pairs", fake)


@aio
async def test_qdrant가_준_남의_카드는_버린다(monkeypatch):
    """벡터 저장소는 신뢰 경계가 아니다 — 노드는 RLS가 정한다."""
    _patch_pairs(monkeypatch, [(MINE_A, STRANGER, 0.3), (MINE_A, MINE_B, 0.4)])
    out = await home.get_concept_map(FakeClient(), "u1")
    ids = {n["id"] for n in out["nodes"]}
    assert ids == {MINE_A, MINE_B}
    assert len(out["edges"]) == 1
    assert {out["edges"][0]["a"], out["edges"][0]["b"]} == {MINE_A, MINE_B}


@aio
async def test_먼_쌍은_선을_안_긋는다(monkeypatch):
    """게이트가 없으면 남남까지 이어져 지도가 한 덩어리가 된다(D182 실측 구간)."""
    far = home.CONCEPT_MAP_MAX_DISTANCE + 0.05
    _patch_pairs(monkeypatch, [(MINE_A, MINE_B, far)])
    out = await home.get_concept_map(FakeClient(), "u1")
    assert out["edges"] == []


@aio
async def test_경계값은_통과한다(monkeypatch):
    _patch_pairs(monkeypatch, [(MINE_A, MINE_B, home.CONCEPT_MAP_MAX_DISTANCE)])
    out = await home.get_concept_map(FakeClient(), "u1")
    assert len(out["edges"]) == 1


@aio
async def test_자기_자신과의_선은_버린다(monkeypatch):
    _patch_pairs(monkeypatch, [(MINE_A, MINE_A, 0.0)])
    out = await home.get_concept_map(FakeClient(), "u1")
    assert out["edges"] == []


@aio
async def test_AI_개념_카드만_묻는다(monkeypatch):
    """메모는 임베딩이 없어 의미로 못 묶는다(사용자 결정 2026-08-06)."""
    _patch_pairs(monkeypatch, [])
    c = FakeClient()
    await home.get_concept_map(c, "u1")
    q = next(p for p in c.params if p["table"] == "canvas_items")
    assert q["kind"] == "eq.concept"
    assert q["source"] == "eq.ai"


@aio
async def test_카드가_없으면_벡터를_안_묻는다(monkeypatch):
    called = {"n": 0}
    from app.services import qdrant_store

    async def fake(*a, **k):
        called["n"] += 1
        return []

    monkeypatch.setattr(qdrant_store, "concept_pairs", fake)
    out = await home.get_concept_map(FakeClient(items=[]), "u1")
    assert out == {"nodes": [], "edges": [], "sessions": []}
    assert called["n"] == 0


@aio
async def test_벡터_조회가_죽어도_노드는_나온다(monkeypatch):
    """선이 없는 지도는 쓸모가 줄 뿐이지만, 빈 화면은 고장과 구분되지 않는다."""
    from app.services import qdrant_store

    async def boom(*a, **k):
        return []  # concept_pairs가 실패를 삼키고 빈 목록을 준다

    monkeypatch.setattr(qdrant_store, "concept_pairs", boom)
    out = await home.get_concept_map(FakeClient(), "u1")
    assert len(out["nodes"]) == 2
    assert out["edges"] == []


@aio
async def test_본문은_미리보기만_실린다(monkeypatch):
    """지도는 읽는 곳이 아니라 찾는 곳이다 — 본문 전체를 실으면 응답이 부푼다."""
    _patch_pairs(monkeypatch, [])
    long_body = "가" * 500
    c = FakeClient(items=[{
        "id": MINE_A, "session_id": "s1", "title": "긴 카드", "body": long_body,
        "tag": None, "created_at": "2026-08-06T00:00:00Z",
    }])
    out = await home.get_concept_map(c, "u1")
    assert len(out["nodes"][0]["preview"]) <= 120
    assert "body" not in out["nodes"][0]
