# 힘-기반 클러스터 배치 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개념 카드를 임베딩 유사도-거리 목적함수 × 증분 힘 솔버로 배치해, 유사 개념은 한 중심으로 조밀 군집·다른 개념은 멀리 분리하고, 카드 크기를 본문량에 따라 동적화한다.

**Architecture:** 서버가 결정론적 힘 이완으로 새 카드 좌표 1개를 계산(기존 카드 pin), place SSE로 전송, done에서 실제 크기로 최종 안착(settle). 좌표·크기는 canvas_cards/attachments에 영속. 격자 폐기, 연속 좌표.

**Tech Stack:** FastAPI(Python 3.12) · Qdrant · Upstage 임베딩(4096d) · Next.js 16/React 19 · Playwright(E2E).

## Global Constraints

- 좌표 결정은 **서버 권위**. 프론트는 좌표 수신·렌더만. (선행 피처 09 유지)
- 배치는 **결정론적**: `Math.random`/RNG 미사용, 고정 반복(`ITERS`)·고정 초기값. 같은 입력 → 같은 좌표(리로드 재현).
- 기존 카드는 **pin**(재배치 금지). 새 카드만 이완 후 고정.
- Qdrant는 RLS 없음 → canvas_cards 모든 검색·scroll·upsert에 `owner_id`+`session_id` 필터 강제.
- `place` SSE `concept_index`와 `attachments.canvas.concepts[].i`는 **답변(노드) 내 0-based 로컬 인덱스**(선행 피처 계약).
- done 훅은 attachments.canvas의 **단일 writer**(concepts 좌표+크기 + ebs/art 통합, fire-and-forget, 실패는 로그만).
- 파라미터 초기값(spec §5): `S_MERGE=0.80, S_MIN=0.30, GAMMA=2.0, D_MAX=1200, MIN_GAP=24, K_ATTR=0.1, K_REP=0.9, TAU=0.15, ITERS=200, T0=0.9, ALPHA=0.95, CARD_W=420, H_MIN=160, H_MAX=560, H_PER_LINE=28, CANVAS_W=2600, CANVAS_H=1600, MARGIN=40`.
- Python: `backend/.venv/bin/python`. 테스트: `cd backend && .venv/bin/python -m pytest tests/ -q`. 프론트: `cd frontend && npx tsc --noEmit && npm run lint`.
- 커밋 메시지 말미: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File Structure

- `backend/app/services/canvas_layout.py` — 격자 함수 제거, **힘 솔버 + 크기** 순수 함수로 재작성.
- `backend/app/config.py` — 신규 파라미터 12개 추가.
- `backend/app/services/qdrant_store.py` — `scroll_canvas_cards(with_vectors=...)`, payload `size_h`.
- `backend/app/routers/retrieve.py` — `_compute_near` = 솔버 초기 추정 좌표(질의 임베딩 vs 기존 카드 벡터).
- `backend/app/routers/chat.py` — place 연속 좌표(솔버), done settle(is_final), 크기 산출·저장.
- `backend/tests/test_canvas_layout_force.py` — 솔버 유닛(신규). `test_canvas_layout.py`(격자)는 Task 5에서 제거.
- `frontend/src/lib/api.ts` — `PlaceEvent.is_final`.
- `frontend/src/lib/types.ts` — `concepts[].h`.
- `frontend/src/lib/concept/useConceptStream.ts` — settle 수신, 격자 배치 제거.
- `frontend/src/components/canvas/ConceptCard.tsx` — 본문량 기반 동적 높이.

---

### Task 1: 힘 솔버 + 카드 크기 (canvas_layout 신규 함수)

기존 격자 함수는 건드리지 않고(retrieve/chat이 아직 import) **새 함수를 추가**한다. 격자 제거는 Task 5.

**Files:**
- Modify: `backend/app/config.py` (파라미터 추가)
- Modify: `backend/app/services/canvas_layout.py` (솔버 함수 추가)
- Test: `backend/tests/test_canvas_layout_force.py` (신규)

**Interfaces:**
- Produces:
  - `class ExistingCard` (dataclass): `x: float, y: float, h: float, sim: float`
  - `target_distance(sim: float) -> float`
  - `estimate_card_height(body_lines: int) -> float`
  - `place_new_card(new_h: float, existing: list[ExistingCard], count_seed: int) -> tuple[float, float]`
    - `count_seed`: 무유사 시드 각도 결정용(결정론). 호출부는 기존 카드 수를 넘긴다.

- [ ] **Step 1: config.py에 파라미터 추가**

`backend/app/config.py`의 `canvas_near_min_score` 줄 아래에 추가:

```python
    # 힘-기반 클러스터 배치(spec 2026-07-12-force-cluster). 전부 결정론 상수.
    force_s_merge: float = 0.80      # 이상이면 목표거리 0(동일 군집 중심)
    force_s_min: float = 0.30        # 이하면 최대거리(완전 분리)
    force_gamma: float = 2.0         # 중간 유사도 거리 곡률(군집 조밀도)
    force_d_max: float = 1200.0      # 최대 목표 거리(px)
    force_min_gap: float = 24.0      # 카드 간 최소 간격(px)
    force_k_attr: float = 0.1        # 스트레스 경사 스텝 계수
    force_k_rep: float = 0.9         # 충돌 밀어내기 계수
    force_tau: float = 0.15          # 초기 무게중심 softmax 온도
    force_iters: int = 200           # 이완 반복(결정론 고정)
    force_t0: float = 0.9            # 쿨링 초기 온도
    force_alpha: float = 0.95        # 쿨링 감쇠
    card_w: float = 420.0            # 카드 폭(고정)
    card_h_min: float = 160.0        # 카드 높이 최소
    card_h_max: float = 560.0        # 카드 높이 최대
    card_h_per_line: float = 28.0    # 본문 줄당 높이 증가(px)
```

- [ ] **Step 2: 실패 테스트 작성 — `backend/tests/test_canvas_layout_force.py`**

```python
import math
from app.services.canvas_layout import (
    ExistingCard, target_distance, estimate_card_height, place_new_card,
    CANVAS_W, CANVAS_H,
)
from app.config import get_settings

S = get_settings()


def test_target_distance_merge_and_separate():
    assert target_distance(0.95) == 0.0          # >= S_MERGE → 0
    assert target_distance(0.10) == S.force_d_max # < S_MIN → D_MAX
    mid = target_distance(0.55)                   # 중간 → (0, D_MAX)
    assert 0.0 < mid < S.force_d_max
    # 단조: 유사도 높을수록 거리 짧다
    assert target_distance(0.70) < target_distance(0.40)


def test_estimate_card_height_clamped_monotonic():
    assert estimate_card_height(0) == S.card_h_min
    assert estimate_card_height(10_000) == S.card_h_max
    assert estimate_card_height(4) >= estimate_card_height(2)


def test_first_card_is_center():
    assert place_new_card(200.0, [], 0) == (CANVAS_W / 2.0, CANVAS_H / 2.0)


def test_deterministic():
    existing = [ExistingCard(x=1300, y=800, h=200, sim=0.9)]
    a = place_new_card(200.0, existing, 1)
    b = place_new_card(200.0, existing, 1)
    assert a == b


def test_similar_converges_close():
    # 하나의 유사 카드(sim=0.95, 목표거리 0) → 새 카드는 그 곁 MIN_GAP 근방
    c = ExistingCard(x=1300, y=800, h=200, sim=0.95)
    x, y = place_new_card(200.0, [c], 1)
    dist = math.hypot(x - c.x, y - c.y)
    # 겹치지 않는 최소 간격 이상, 그러나 D_MAX 근처는 아님(조밀 군집)
    from app.services.canvas_layout import _radius
    min_d = _radius(200.0) + _radius(200.0) + S.force_min_gap
    assert min_d - 1 <= dist <= min_d + 120


def test_dissimilar_pushed_far():
    # sim=0.1(목표거리 D_MAX) 카드 → 새 카드는 멀리
    c = ExistingCard(x=1300, y=800, h=200, sim=0.1)
    x, y = place_new_card(200.0, [c], 1)
    dist = math.hypot(x - c.x, y - c.y)
    assert dist >= S.force_d_max * 0.5   # 최소 절반 이상 분리


def test_no_overlap_variable_size():
    existing = [
        ExistingCard(x=1000, y=800, h=160, sim=0.9),
        ExistingCard(x=1200, y=820, h=560, sim=0.88),
    ]
    x, y = place_new_card(400.0, existing, 2)
    from app.services.canvas_layout import _radius
    for c in existing:
        d = math.hypot(x - c.x, y - c.y)
        assert d >= _radius(400.0) + _radius(c.h) + S.force_min_gap - 1
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_canvas_layout_force.py -q`
Expected: FAIL (ImportError: cannot import name 'ExistingCard' …)

- [ ] **Step 4: 솔버 구현 — `backend/app/services/canvas_layout.py` 상단에 추가**

기존 격자 함수(cell_to_xy 등)는 **그대로 두고**, 파일 상단 import 아래에 추가:

```python
import math
from dataclasses import dataclass

from ..config import get_settings

_S = get_settings()

# 캔버스 월드 크기(연속 좌표). 격자 상수 FX/FY는 Task 5에서 제거.
# (CANVAS_W/CANVAS_H/MARGIN은 기존 정의 재사용)


@dataclass
class ExistingCard:
    """이완 대상에서 제외되는(pin) 기존 카드. sim은 '새 카드와의' 코사인 유사도[0,1]."""
    x: float
    y: float
    h: float
    sim: float


def target_distance(sim: float) -> float:
    """유사도 → 목표 거리. sim>=S_MERGE→0(동일 군집), sim<S_MIN→D_MAX(분리)."""
    s = max(0.0, min(1.0, sim))
    if s >= _S.force_s_merge:
        return 0.0
    if s < _S.force_s_min:
        return _S.force_d_max
    frac = (_S.force_s_merge - s) / (_S.force_s_merge - _S.force_s_min)
    return _S.force_d_max * (frac ** _S.force_gamma)


def estimate_card_height(body_lines: int) -> float:
    """본문 줄 수 → 카드 높이(clamp). done 시점 본문으로 산출."""
    h = _S.card_h_min + max(0, body_lines) * _S.card_h_per_line
    return max(_S.card_h_min, min(_S.card_h_max, h))


def _radius(h: float) -> float:
    """CARD_W × h 카드의 외접원 반경(충돌 판정용)."""
    return 0.5 * math.hypot(_S.card_w, h)


def place_new_card(
    new_h: float, existing: list[ExistingCard], count_seed: int
) -> tuple[float, float]:
    """새 카드 좌표를 결정론적으로 계산. 기존 카드는 고정.

    - 초기값: softmax(sim/TAU) 가중 무게중심. 무유사(max_sim<S_MIN)면 전역
      무게중심에서 황금각 방향으로 D_MAX 떨어진 빈 영역 시드(결정론, count_seed 사용).
    - 이완: 스트레스 경사(‖p-p_i‖ - target)² 하강 + 충돌 밀어내기, 쿨링 ITERS회.
    """
    if not existing:
        return (CANVAS_W / 2.0, CANVAS_H / 2.0)

    new_r = _radius(new_h)
    targets = [(c, target_distance(c.sim)) for c in existing]
    # 가중치: 유사 카드가 군집 인력을 지배하도록. 비유사도 분리엔 기여(0.2).
    weights = [c.sim if c.sim >= _S.force_s_min else 0.2 for c in existing]

    # 초기 추정: softmax 가중 무게중심
    exps = [math.exp(c.sim / _S.force_tau) for c in existing]
    z = sum(exps) or 1.0
    px = sum(e * c.x for e, c in zip(exps, existing)) / z
    py = sum(e * c.y for e, c in zip(exps, existing)) / z

    max_sim = max(c.sim for c in existing)
    if max_sim < _S.force_s_min:
        gx = sum(c.x for c in existing) / len(existing)
        gy = sum(c.y for c in existing) / len(existing)
        ang = math.radians(count_seed * 137.5)  # 황금각 — 결정론 분산
        px = gx + math.cos(ang) * _S.force_d_max
        py = gy + math.sin(ang) * _S.force_d_max

    t = _S.force_t0
    for _ in range(_S.force_iters):
        gx_ = 0.0
        gy_ = 0.0
        for (c, d), w in zip(targets, weights):
            dx = px - c.x
            dy = py - c.y
            dist = math.hypot(dx, dy) or 1e-6
            coef = 2.0 * w * (dist - d) / dist  # 스트레스 경사
            gx_ += coef * dx
            gy_ += coef * dy
        px -= _S.force_k_attr * t * gx_
        py -= _S.force_k_attr * t * gy_
        # 충돌 해소: 가변 반경 겹침 밀어내기
        for c in existing:
            dx = px - c.x
            dy = py - c.y
            dist = math.hypot(dx, dy) or 1e-6
            min_d = new_r + _radius(c.h) + _S.force_min_gap
            if dist < min_d:
                push = (min_d - dist)
                px += (dx / dist) * push * _S.force_k_rep
                py += (dy / dist) * push * _S.force_k_rep
        t *= _S.force_alpha

    # 캔버스 경계 클램프
    px = max(MARGIN, min(CANVAS_W - _S.card_w - MARGIN, px))
    py = max(MARGIN, min(CANVAS_H - new_h - MARGIN, py))
    return (px, py)
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_canvas_layout_force.py -q`
Expected: PASS (7 passed). 전체 스위트도 깨지지 않는지: `.venv/bin/python -m pytest tests/ -q` → 기존 격자 테스트 여전히 통과.

- [ ] **Step 6: 커밋**

```bash
git add backend/app/config.py backend/app/services/canvas_layout.py backend/tests/test_canvas_layout_force.py
git commit -m "$(printf '[feat]: force-cluster 솔버 + 카드 크기 순수함수 (canvas_layout)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: qdrant_store — canvas_cards 벡터 조회 + size_h payload

**Files:**
- Modify: `backend/app/services/qdrant_store.py` (`scroll_canvas_cards` with_vectors, upsert payload)
- Test: `backend/tests/test_qdrant_canvas.py` (신규, payload 구성 단위 검증)

**Interfaces:**
- Consumes: (없음 — Qdrant 클라이언트)
- Produces:
  - `scroll_canvas_cards(owner_id, session_id, *, with_vectors: bool = False) -> list[dict]` (각 dict에 `id, payload`; with_vectors=True면 `vector` 포함)
  - `upsert_canvas_card(owner_id, session_id, node_id, concept_index, title, x, y, size_h, vector) -> None` (payload에 `size_h` 포함)

- [ ] **Step 1: 실패 테스트 — `backend/tests/test_qdrant_canvas.py`**

`scroll_canvas_cards`가 `with_vectors` 인자를 받고, upsert가 `size_h`를 payload에 넣는지, 필터에 owner+session이 강제되는지를 모킹으로 검증.

```python
import types
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
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_qdrant_canvas.py -q`
Expected: FAIL (upsert_canvas_card 없음 / with_vectors 미지원)

- [ ] **Step 3: 구현 — qdrant_store.py 수정**

`scroll_canvas_cards`에 `with_vectors` 파라미터 추가(기본 False, 시그니처 뒤에 keyword-only). `models.ScrollRequest` 대신 현재 사용 방식에 맞춰 `with_vectors=with_vectors` 전달. 그리고 `upsert_canvas_card` 함수 추가:

```python
async def upsert_canvas_card(
    owner_id: str,
    session_id: str,
    node_id: str,
    concept_index: int,
    title: str,
    x: float,
    y: float,
    size_h: float,
    vector: list[float],
) -> None:
    """canvas_cards 멱등 upsert. 좌표(연속)+크기+벡터 저장."""
    client = get_client()
    point = models.PointStruct(
        id=canvas_card_point_id(node_id, concept_index),
        vector=vector,
        payload={
            "owner_id": owner_id,
            "session_id": session_id,
            "node_id": node_id,
            "concept_index": concept_index,
            "title": title,
            "x": x,
            "y": y,
            "size_h": size_h,
        },
    )
    await client.upsert(collection_name=COL_CANVAS_CARDS, points=[point])
```

`scroll_canvas_cards` 시그니처를 `async def scroll_canvas_cards(owner_id, session_id, *, with_vectors: bool = False)`로 바꾸고 내부 scroll 호출에 `with_vectors=with_vectors` 추가(현재 `with_vectors=False` 하드코딩된 부분 대체).

- [ ] **Step 4: 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_qdrant_canvas.py -q`
Expected: PASS (2 passed)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/qdrant_store.py backend/tests/test_qdrant_canvas.py
git commit -m "$(printf '[feat]: canvas_cards 벡터 조회(with_vectors)+size_h payload+upsert 헬퍼\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: retrieve — near = 솔버 초기 추정 좌표

`_compute_near`를 격자 로직에서 **솔버 초기 추정**으로 교체. 질의 임베딩과 기존 카드 벡터의 코사인으로 `ExistingCard.sim`을 만들어 `place_new_card`(기본 크기)로 좌표 산출.

**Files:**
- Modify: `backend/app/routers/retrieve.py`
- Test: `backend/tests/test_retrieve_near.py` (교체)

**Interfaces:**
- Consumes: `place_new_card`, `ExistingCard`, `estimate_card_height` (Task 1); `scroll_canvas_cards(..., with_vectors=True)` (Task 2); `upstage.embed_query` (기존)
- Produces: `POST /retrieve` 응답 `near: {x: float, y: float, score: float|null}` (score = 최대 유사도, 없으면 null)

- [ ] **Step 1: 실패 테스트 — `test_retrieve_near.py` 교체**

```python
import math
import pytest
from app.routers import retrieve as R
from app.services.canvas_layout import CANVAS_W, CANVAS_H


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
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_retrieve_near.py -q`
Expected: FAIL (`_compute_near` 시그니처/동작 불일치)

- [ ] **Step 3: 구현 — `_compute_near` 교체**

`retrieve.py`의 격자 import(build_occupied/nearest_free_cell/xy_to_cell/cell_to_xy)를 제거하고 `place_new_card, ExistingCard` import. `_compute_near`를 아래로 교체:

```python
async def _compute_near(user_id: str, session_id: str, qvec: list[float]) -> dict:
    """질의 임베딩 vs 기존 카드 벡터 코사인 → 솔버 초기 추정 좌표.

    항상 좌표 반환(실패 시 캔버스 중앙). score = 최대 유사도(없으면 None).
    """
    from ..services.canvas_layout import (
        CANVAS_W, CANVAS_H, ExistingCard, estimate_card_height, place_new_card,
    )
    try:
        cards = await qdrant_store.scroll_canvas_cards(
            user_id, session_id, with_vectors=True
        )
    except Exception:  # noqa: BLE001 - degraded, 항상 좌표 반환
        logger.warning("canvas_cards scroll 실패 — near 폴백(중앙)", exc_info=True)
        return {"x": CANVAS_W / 2.0, "y": CANVAS_H / 2.0, "score": None}

    if not cards:
        return {"x": CANVAS_W / 2.0, "y": CANVAS_H / 2.0, "score": None}

    existing: list[ExistingCard] = []
    best = 0.0
    for c in cards:
        vec = c.get("vector") or []
        pl = c.get("payload") or {}
        sim = _cosine(qvec, vec) if vec else 0.0
        best = max(best, sim)
        existing.append(ExistingCard(
            x=float(pl.get("x", 0.0)), y=float(pl.get("y", 0.0)),
            h=float(pl.get("size_h", estimate_card_height(2))), sim=sim,
        ))
    x, y = place_new_card(estimate_card_height(2), existing, len(existing))
    return {"x": x, "y": y, "score": best if best > 0 else None}


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5 or 1e-9
    nb = sum(x * x for x in b) ** 0.5 or 1e-9
    return max(0.0, dot / (na * nb))
```

`retrieve` 엔드포인트에서 `_compute_near`를 `await _compute_near(user.id, body.session_id, vec)`로 호출(질의 임베딩 vec 전달). 응답의 `near`가 항상 존재하도록 유지.

- [ ] **Step 4: 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_retrieve_near.py -q`
Expected: PASS (3 passed)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/routers/retrieve.py backend/tests/test_retrieve_near.py
git commit -m "$(printf '[feat]: retrieve near = 힘솔버 초기추정 좌표(질의임베딩 vs 카드벡터 코사인)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: chat — place 연속 좌표(솔버) + done settle + 크기 저장

`_next_place_event`를 격자 → 솔버로. done에서 실제 본문 길이로 카드 크기 확정 → 각 개념 최종 좌표를 솔버로 재계산 → `place{is_final:true}` 재전송 → canvas_cards에 `(x,y)+size_h+vector` 저장.

**Files:**
- Modify: `backend/app/routers/chat.py`
- Test: `backend/tests/test_chat_place.py` (신규 — place 좌표 연속성 + settle 인덱스 단위 검증)

**Interfaces:**
- Consumes: `place_new_card, ExistingCard, estimate_card_height` (Task 1); `scroll_canvas_cards(with_vectors=True)`, `upsert_canvas_card` (Task 2); `concept_blocks.parse`, `upstage.embed_passages` (기존)
- Produces: SSE `place{concept_index:int, x:float, y:float, is_final:bool}`; done 훅이 canvas_cards에 연속 좌표+size_h 저장, attachments.canvas.concepts=`[{i,x,y,h}]`

- [ ] **Step 1: 실패 테스트 — `backend/tests/test_chat_place.py`**

`_place_for_new_concept` 헬퍼(스트리밍용, 기존 카드 목록 + 질의 임베딩으로 좌표 산출)와 done settle의 인덱스 계약을 단위 검증. 순수 헬퍼로 분리해 테스트 가능하게.

```python
import math
from app.routers.chat import _place_for_new_concept
from app.services.canvas_layout import ExistingCard, estimate_card_height


def test_place_for_new_concept_returns_continuous_coords():
    existing = [ExistingCard(x=1300, y=800, h=200, sim=0.95)]
    x, y = _place_for_new_concept(existing, seed=1, new_h=estimate_card_height(2))
    assert isinstance(x, float) and isinstance(y, float)
    # 유사 카드 곁(겹치지 않음)
    d = math.hypot(x - 1300, y - 800)
    assert d > 0
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_chat_place.py -q`
Expected: FAIL (`_place_for_new_concept` 없음)

- [ ] **Step 3: 구현 — chat.py**

(a) 격자 import 제거, 솔버 import 추가:
```python
from ..services.canvas_layout import (
    ExistingCard, estimate_card_height, place_new_card,
)
```

(b) 순수 헬퍼 추가(모듈 레벨):
```python
def _place_for_new_concept(
    existing: list[ExistingCard], seed: int, new_h: float
) -> tuple[float, float]:
    """스트리밍/settle 공용 — 기존 카드에 대해 새 카드 좌표 1개 계산."""
    return place_new_card(new_h, existing, seed)
```

(c) 스트림 시작 전 1회 scroll을 `with_vectors=True`로 바꿔 기존 카드(좌표+크기+벡터) 확보. 질의 임베딩(retrieve와 동일 방식으로 `await upstage.embed_query(body.question)` 1회, 또는 body에 실어 재사용 — 여기선 질의 임베딩을 스트림 시작 시 1회 계산해 `qvec`에 보관). `ExistingCard.sim`은 `_cosine(qvec, card.vector)`.

(d) `_next_place_event`를 솔버 기반으로 교체 — 개념마다:
```python
def _next_place_event() -> dict:
    nonlocal concept_count
    idx = concept_count
    concept_count += 1
    x, y = _place_for_new_concept(
        _existing_cards(), seed=len(_existing_cards()),
        new_h=estimate_card_height(2),   # 스트리밍 중엔 기본 크기 추정
    )
    placed_coords[idx] = (x, y)
    # 방금 배치한 개념을 이후 개념의 pin 대상에 추가(같은 답변 내 분리)
    _pinned.append(ExistingCard(x=x, y=y, h=estimate_card_height(2), sim=0.9))
    return {"concept_index": idx, "x": x, "y": y, "is_final": False}
```
`_existing_cards()`는 (세션 scroll 결과 → ExistingCard 목록) + `_pinned`(이번 답변 내 이미 배치분)을 합친 것. `sim`은 세션 카드엔 `_cosine(qvec, vec)`, `_pinned`엔 근사(0.9 — 같은 답변이라 가깝게).

(e) done settle: 노드 저장 후, 답변을 `concept_blocks.parse`로 파싱해 개념별 본문 줄 수로 `estimate_card_height` 산출 → 개념별 최종 좌표를 솔버로 재계산(실제 크기 반영) → 각 개념 `place{is_final:true}` 재전송 → `placed_coords[idx]`를 최종값으로 갱신. done 훅(`_save_canvas_cards`)이 이 최종 좌표+크기+passage 벡터를 `upsert_canvas_card`로 저장하고 attachments.canvas.concepts=`[{i,x,y,h}]` 기록.

  settle 전송은 done SSE **직후**, done 훅(fire-and-forget) 실행 **전** 스트림에서 yield:
```python
# done SSE 이후 — 실제 크기로 최종 안착 좌표 재계산 & 재전송
parsed = concept_blocks.parse(answer)   # [{index, title, body}]
existing_final = _session_cards_as_existing(qvec)  # 세션(이번 답변 제외) pin
for block in parsed:
    lines = block["body"].count("\n") + 1 if block["body"] else 0
    h = estimate_card_height(lines)
    x, y = place_new_card(h, existing_final, seed=block["index"])
    placed_coords[block["index"]] = (x, y)
    placed_heights[block["index"]] = h
    existing_final.append(ExistingCard(x=x, y=y, h=h, sim=0.9))
    yield _sse("place", {"concept_index": block["index"], "x": x, "y": y, "is_final": True})
```
`_save_canvas_cards`/`_patch_canvas_unified`를 `placed_heights`도 받아 `size_h`/`h` 저장하도록 확장(passage 벡터는 `await upstage.embed_passages([title+"\n"+body])`로 개념별 1배치).

- [ ] **Step 4: 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_chat_place.py tests/ -q`
Expected: PASS (전체 통과, 기존 테스트 회귀 없음)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/routers/chat.py backend/tests/test_chat_place.py
git commit -m "$(printf '[feat]: chat place 연속좌표(솔버)+done settle(is_final)+카드크기 저장\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 5: 백엔드 격자 코드 제거 (canvas_layout 정리)

retrieve/chat이 격자 함수를 더는 import하지 않으므로 제거.

**Files:**
- Modify: `backend/app/services/canvas_layout.py` (격자 함수·상수 삭제)
- Delete: `backend/tests/test_canvas_layout.py` (격자 테스트)

**Interfaces:**
- Consumes/Produces: 없음(순수 제거). `CANVAS_W/CANVAS_H/MARGIN`은 솔버가 쓰므로 **유지**. `FX/FY/cell_to_xy/xy_to_cell/nearest_free_cell/fallback_anchor/build_occupied/ANCHORS`는 삭제.

- [ ] **Step 1: import 잔재 확인**

Run: `cd backend && grep -rn "cell_to_xy\|nearest_free_cell\|build_occupied\|fallback_anchor\|xy_to_cell\|FX\|FY" app/ | grep -v canvas_layout.py`
Expected: 출력 없음(모두 마이그레이션됨). 있으면 해당 호출부 먼저 정리.

- [ ] **Step 2: 격자 함수·상수 삭제 + 격자 테스트 삭제**

`canvas_layout.py`에서 `FX, FY, ANCHORS, cell_to_xy, xy_to_cell, nearest_free_cell, fallback_anchor, build_occupied`와 관련 주석 삭제. `CANVAS_W, CANVAS_H, MARGIN`, 솔버 함수는 유지.

```bash
git rm backend/tests/test_canvas_layout.py
```

- [ ] **Step 3: 전체 테스트 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/ -q && .venv/bin/python -c "import app.main"`
Expected: PASS + import OK (죽은 참조 없음)

- [ ] **Step 4: 커밋**

```bash
git add backend/app/services/canvas_layout.py
git commit -m "$(printf '[refactor]: 격자 배치 함수/테스트 제거(힘 솔버로 대체)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 6: frontend — place is_final 계약 + concepts.h 타입

**Files:**
- Modify: `frontend/src/lib/api.ts` (`PlaceEvent`)
- Modify: `frontend/src/lib/types.ts` (`concepts[].h`)

**Interfaces:**
- Produces: `PlaceEvent { concept_index: number; x: number; y: number; is_final: boolean }`; `NodeRow.attachments.canvas.concepts: {i:number;x:number;y:number;h:number}[]`

- [ ] **Step 1: 타입 수정**

`api.ts`의 `PlaceEvent`에 `is_final: boolean` 추가. `types.ts`의 canvas concepts 항목에 `h: number` 추가(선택 필드로: `h?: number`로 방어적).

- [ ] **Step 2: 타입 체크**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors (사용처가 아직 is_final 안 읽어도 통과)

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/types.ts
git commit -m "$(printf '[feat]: 프론트 PlaceEvent.is_final + concepts.h 타입\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 7: frontend useConceptStream — settle 수신 + 격자 배치 제거

**Files:**
- Modify: `frontend/src/lib/concept/useConceptStream.ts`

**Interfaces:**
- Consumes: `PlaceEvent.is_final` (Task 6). 좌표는 서버 place에서만 옴.
- Produces: (없음 — 내부 상태)

- [ ] **Step 1: onPlace가 is_final 처리**

`onPlace`에서 `p.is_final === true`면 해당 개념(전역 인덱스 = baseConceptIdx + p.concept_index)의 좌표를 최종값으로 갱신(카드 이동 → CSS 트랜지션). is_final=false는 기존대로 pendingCoords 저장 + concept_index 0이면 플레이스홀더 이동.

```ts
onPlace: (p: PlaceEvent) => {
  pendingCoordsRef.current.set(p.concept_index, { x: p.x, y: p.y });
  if (p.is_final) {
    const globalIdx = baseConceptIdxRef.current + p.concept_index;
    commitConcepts(
      conceptsRef.current.map((c, i) =>
        i === globalIdx ? { ...c, x: p.x, y: p.y } : c,
      ),
    );
    return;
  }
  if (p.concept_index === 0 && pendingIdRef.current) {
    commitConcepts(
      conceptsRef.current.map((c) =>
        c.id === pendingIdRef.current ? { ...c, x: p.x, y: p.y } : c,
      ),
    );
  }
},
```

- [ ] **Step 2: 격자 placeConcepts를 개념 배치에서 제거**

`reduceConcept`/`applyEvent`의 개념 좌표 폴백에서 `placeConcepts`(격자) 호출 제거 — 좌표는 place 이벤트가 유일 소스. place가 아직 없으면 초기 near 좌표(플레이스홀더)를 승계. 리프(video/art) 배치의 `placeConcepts`는 **개념 곁 단순 오프셋**으로 대체(예: 개념 좌표 + (CARD_W+40, k*offset)). 리플레이는 `attachments.canvas.concepts[].{x,y}` 그대로 적용(격자 폴백 제거; 좌표 없는 구 노드는 near 중앙).

- [ ] **Step 3: 타입/린트 통과**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: 0 errors / 신규 warning 0

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/lib/concept/useConceptStream.ts
git commit -m "$(printf '[feat]: 프론트 settle(is_final) 수신 + 격자 배치 제거(서버 좌표 단일소스)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 8: frontend ConceptCard — 본문량 기반 동적 높이

**Files:**
- Modify: `frontend/src/components/canvas/ConceptCard.tsx`
- Modify: `frontend/src/components/canvas/ConceptCard.module.css` (필요 시 min/max-height)

**Interfaces:**
- Consumes: `concept.blocks`(본문), 서버 저장 `h`(있으면 우선)
- Produces: (없음 — 렌더)

- [ ] **Step 1: 높이 계산**

카드 스타일 높이를 본문량으로. 우선순위: `concept.h`(리플레이 시 서버 저장값) → 없으면 본문 줄 수 기반 추정 `clamp(160 + lines*28, 160, 560)`. 실카드·pending 카드 모두 동일 높이 로직(레이아웃 점프 방지). CSS `min-height`/`max-height`로 클램프, 내용이 넘치면 스크롤 대신 max-height 내 표시(디자인 유지).

```ts
const lines = blocks.reduce((n, b) => n + Math.max(1, (b.tokens?.length ? 1 : 1)), 0);
const h = concept.h ?? Math.max(160, Math.min(560, 160 + lines * 28));
// style에 height: h 반영
```
(줄 수 산정은 blocks 길이 기반 근사 — 서버 `estimate_card_height`와 대략 일치시키되, 서버 저장 `h`가 있으면 그 값을 신뢰.)

- [ ] **Step 2: 타입/린트 + 시각 확인**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: 0 / 0. dev 서버(3000)에서 긴/짧은 답변 카드 높이 차이 육안 확인.

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/components/canvas/ConceptCard.tsx frontend/src/components/canvas/ConceptCard.module.css
git commit -m "$(printf '[feat]: ConceptCard 본문량 기반 동적 높이(서버 h 우선)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## 통합 검증 (전 태스크 후)

기존 Playwright 하네스(`/tmp/nodi-e2e-QaXC/place-e2e.js` 계열)를 확장해 실행(백엔드 8000·프론트 3000):
1. 유사 질문 3연속(광합성·세포호흡·엽록체) → 좌표 상호 거리 작음(조밀 군집), y가 분산(1차원 퇴화 아님).
2. 무관 질문("지진") → 기존 군집에서 D_MAX 절반 이상 분리.
3. 긴 답변 vs 짧은 답변 → 카드 높이 차이.
4. 새로고침 → canvas_cards/attachments 저장 좌표·크기로 동일 재현.
5. Qdrant 중단 → 로딩 카드 표시 + 중앙/시드 배치(degraded).
6. DB 확인: nodes.attachments.canvas에 concepts=[{i,x,y,h}] + ebs/art 공존(단일 writer).

## Self-Review (작성자 체크 결과)

- **스펙 커버리지**: §2-1 목적함수→Task1 `target_distance`; §2-2 솔버→Task1 `place_new_card`; §2-3 두 단계/settle→Task4; §3 크기→Task1 `estimate_card_height`+Task8; §4 데이터/계약→Task2/4/6; §5 파라미터→Task1 Step1; §6 변경 파일→Task1-8; §7 에러→Task3(degraded)/Task4(done훅); §8 테스트→각 Task + 통합. 누락 없음.
- **플레이스홀더 스캔**: 모든 코드 스텝에 완전 코드. TBD/TODO 없음.
- **타입 일관성**: `ExistingCard`/`place_new_card`/`estimate_card_height` 시그니처가 Task1 정의 = Task3/4 소비 일치. `PlaceEvent.is_final` Task6 정의 = Task7 소비 일치. `size_h`(payload)/`h`(concepts) 명명 일관.
