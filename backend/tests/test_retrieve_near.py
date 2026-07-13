import math
import pytest

# T4: retrieve near가 태그 기반 중앙 폴백으로 전환되며 _compute_near(임베딩 near)가
# 삭제됨. 이 모듈은 삭제된 함수만 검증하므로 전체 skip(파일 제거는 T5 dead-code 정리).
pytest.skip(
    "retrieve._compute_near removed in T4 (tag-based near=center); pruned in T5",
    allow_module_level=True,
)

from app.routers import retrieve as R  # noqa: E402
from app.services.canvas_layout import CANVAS_W, CANVAS_H  # noqa: E402


def _cos(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1e-9
    nb = math.sqrt(sum(x * x for x in b)) or 1e-9
    return dot / (na * nb)


@pytest.mark.asyncio
async def test_near_empty_session_is_center(monkeypatch):
    async def fake_scroll(owner, sid, *, with_vectors=False):
        return []
    monkeypatch.setattr(R.qdrant_store, "scroll_canvas_cards", fake_scroll)
    near = await R._compute_near("u1", "s1", [0.1] * 4096)
    assert near == {"x": CANVAS_W / 2.0, "y": CANVAS_H / 2.0, "score": None}


@pytest.mark.asyncio
async def test_near_similar_card_close(monkeypatch):
    qvec = [1.0] + [0.0] * 4095
    async def fake_scroll(owner, sid, *, with_vectors=False):
        return [{"id": "p1", "vector": qvec,   # 동일 방향 → sim≈1
                 "payload": {"x": 1300.0, "y": 800.0, "size_h": 200.0}}]
    monkeypatch.setattr(R.qdrant_store, "scroll_canvas_cards", fake_scroll)
    near = await R._compute_near("u1", "s1", qvec)
    assert near["score"] is not None and near["score"] > 0.9
    d = math.hypot(near["x"] - 1300.0, near["y"] - 800.0)
    assert d < 700   # 유사 카드 근처(D_MAX 절반 미만)


@pytest.mark.asyncio
async def test_near_qdrant_failure_degrades(monkeypatch):
    async def boom(owner, sid, *, with_vectors=False):
        raise RuntimeError("qdrant down")
    monkeypatch.setattr(R.qdrant_store, "scroll_canvas_cards", boom)
    near = await R._compute_near("u1", "s1", [0.1] * 4096)
    # 항상 좌표 반환(로딩 카드 상시 표시)
    assert "x" in near and "y" in near and near["score"] is None
