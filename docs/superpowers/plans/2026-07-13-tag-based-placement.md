# 태그 기반 카드 배치 Implementation Plan (벡터 배치 폐기)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카드 위치를 임베딩 코사인/힘 솔버 대신 EXAONE `@concept: 제목 | 분류`의 **태그(분류)** 로 정한다 — 새 태그는 Vogel 나선 앵커를 생성하고, 같은 태그는 그 앵커 주변 무겹침 클러스터로 모은다.

**Architecture:** 서버 권위 유지(place SSE 계약 그대로). 세션 카드 상태는 노드 `attachments.canvas.concepts[]`(에 `tag` 추가)에서 재구성한다. 스트리밍 `@concept:` 감지·done settle 모두 `tag_anchor(k)` + `place_by_tag`(기존 AABB 무겹침 나선 재사용)로 배치. 임베딩(질의/응답)·canvas_cards·힘솔버 sim은 카드 위치에서 제거하되, EBS/삽화/교과서/파일 검색용 임베딩은 유지.

**Tech Stack:** FastAPI, 순수 파이썬 기하(canvas_layout), Supabase(nodes.attachments), Next.js/React. 백엔드 pytest, 프론트 tsc/eslint + Playwright.

## Global Constraints

- **place SSE 계약 불변**: `place{concept_index, x, y, is_final}` 그대로. 프론트 렌더/자동포커싱/미니맵/무겹침/단일리프 유지.
- **태그 = 기존 `cluster`(분류)**. 빈 분류 → `"기타"` 폴백. 태그는 세션 **첫 등장 순서 k**로 앵커 인덱스 결정(결정론).
- **`tag_anchor(k)`**: `k=0`→중앙(CANVAS_W/2, CANVAS_H/2); `k>0`→ `r=TAG_R0·√k, angle=k·137.5°`. 난수 없음.
- **`place_by_tag(anchor, existing, new_h)`**: 앵커를 카드 **중심**으로 두고 `_first_free_position`(기존 AABB 무겹침 나선)으로 가장 가까운 빈 자리. 같은 태그=앵커 주변 클러스터, 다른 태그=분리.
- **세션 상태는 attachments에서**: `svc.get_session_nodes(client, session_id)`(created_at.asc, is_navigator 제외) → `attachments.canvas.concepts[{x,y,h,tag}]`. canvas_cards(Qdrant) 스크롤/업서트/임베딩은 위치에서 제거.
- **임베딩 유지 범위**: EBS/삽화/교과서/파일 검색만. 카드 위치·near에는 임베딩 미사용.
- **self-격리 유지**: settle 실패 → `logger.warning`만, error SSE 금지, 스트리밍 좌표 폴백.
- **`git add`는 명시 경로만**(레포에 무관 미추적 파일 다수 — `git add -A` 금지). 커밋 트레일러: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **(프로세스) 서브에이전트는 opus 4.8 사용.**

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `backend/app/services/concept_blocks.py` | 답변 파싱 | `parse` 반환에 `cluster` 추가 |
| `backend/app/services/canvas_layout.py` | 배치 기하 | `tag_anchor`·`place_by_tag` 신설; (T5)힘솔버 제거 |
| `backend/app/config.py` | 설정 | `TAG_R0` 추가; (T5)`canvas_near_min_score` 제거 |
| `backend/app/services/exaone.py` | 프롬프트 | 분류 규칙 강화 |
| `backend/app/routers/chat.py` | 스트림/settle/저장 | 태그 배치·attachments 세션상태·임베딩/canvas_cards 제거·tag 저장 |
| `backend/app/routers/retrieve.py` | 초기 near | `_compute_near`(임베딩) 제거 → near=중앙; ebs/art 유지 |
| `backend/tests/…` | 테스트 | tag_anchor/place_by_tag/parse 유닛; (T5)구 테스트 정리 |
| `frontend/src/lib/concept/useConceptStream.ts` | 파싱/포커스 | PersistedCanvas.concepts[].tag 허용; 첫 place에 포커스 재조정 |

---

## Task 1: `concept_blocks.parse` — cluster 반환

**Files:** Modify `backend/app/services/concept_blocks.py`; Create `backend/tests/test_concept_blocks_cluster.py`

- [ ] **Step 1: 실패 테스트**

`backend/tests/test_concept_blocks_cluster.py`:
```python
from app.services.concept_blocks import parse


def test_parse_returns_cluster():
    answer = "@concept: 명반응 | 광합성\n- 빛을 흡수한다\n@end\n@concept: 세포호흡\n- 에너지를 만든다\n@end"
    blocks = parse(answer)
    assert blocks[0]["cluster"] == "광합성"
    assert blocks[0]["title"] == "명반응"
    assert blocks[1]["cluster"] == ""   # | 없으면 빈 문자열
    assert blocks[1]["title"] == "세포호흡"
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && uv run pytest tests/test_concept_blocks_cluster.py -q`
Expected: FAIL — `KeyError: 'cluster'`.

- [ ] **Step 3: parse에 cluster 추가**

`concept_blocks.py`: `_flush`가 `current_cluster`도 담고, `@concept` 파싱 시 `parts[1]`을 저장.
```python
def parse(answer: str) -> list[dict]:
    blocks: list[dict] = []
    current_title: str | None = None
    current_cluster: str = ""
    current_lines: list[str] = []

    def _flush():
        nonlocal current_title, current_cluster, current_lines
        if current_title is not None:
            body = _strip_markup("\n".join(current_lines))
            blocks.append({
                "index": len(blocks),
                "title": current_title,
                "cluster": current_cluster,
                "body": body,
            })
        current_title = None
        current_cluster = ""
        current_lines = []

    for raw_line in answer.splitlines():
        line = raw_line.rstrip()
        cm = _CONCEPT_RE.match(line)
        if cm:
            _flush()
            parts = cm.group(1).split("|")
            current_title = parts[0].strip()
            current_cluster = parts[1].strip() if len(parts) > 1 else ""
            current_lines = []
            continue
        if line.strip() == "@end":
            _flush()
            continue
        if current_title is not None:
            bm = _BODY_RE.match(line)
            if bm:
                current_lines.append(bm.group(1).strip())
    _flush()
    return blocks
```
(모듈 docstring의 "출력: [{index, title, body}]"도 `cluster` 포함으로 갱신.)

- [ ] **Step 4: 통과 + 회귀**

Run: `cd backend && uv run pytest tests/test_concept_blocks_cluster.py -q && uv run pytest -q`
Expected: 신규 통과, 기존 스위트 회귀 없음(추가 키라 기존 소비자 무영향).

- [ ] **Step 5: 커밋**
```bash
git add backend/app/services/concept_blocks.py backend/tests/test_concept_blocks_cluster.py
git commit -m "$(cat <<'EOF'
[feat]: concept_blocks.parse가 cluster(분류) 반환

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `canvas_layout` — tag_anchor + place_by_tag (+ config TAG_R0)

**Files:** Modify `backend/app/config.py`, `backend/app/services/canvas_layout.py`; Create `backend/tests/test_tag_placement.py`

**Interfaces:** Produces `tag_anchor(k:int)->tuple[float,float]`, `place_by_tag(anchor:tuple[float,float], existing:list[ExistingCard], new_h:float)->tuple[float,float]`.

- [ ] **Step 1: config에 TAG_R0**

`config.py`(force 상수 블록 부근):
```python
    tag_r0: float = 560.0            # 태그 앵커 나선 반경 계수(px) — Vogel r=TAG_R0*√k
```

- [ ] **Step 2: 실패 테스트**

`backend/tests/test_tag_placement.py`:
```python
import math
from app.services.canvas_layout import tag_anchor, place_by_tag, ExistingCard, _overlap, CANVAS_W, CANVAS_H


def test_tag_anchor_center_and_deterministic():
    assert tag_anchor(0) == (CANVAS_W / 2.0, CANVAS_H / 2.0)
    assert tag_anchor(3) == tag_anchor(3)
    assert tag_anchor(1) != tag_anchor(0)


def test_tag_anchors_separated():
    a0, a1, a2 = tag_anchor(0), tag_anchor(1), tag_anchor(2)
    assert math.hypot(a1[0] - a0[0], a1[1] - a0[1]) >= 400
    assert math.hypot(a2[0] - a1[0], a2[1] - a1[1]) >= 200


def test_place_by_tag_clusters_no_overlap():
    a0 = tag_anchor(0)
    existing: list[ExistingCard] = []
    for _ in range(4):
        x, y = place_by_tag(a0, existing, 200.0)
        for c in existing:
            assert _overlap(x, y, 200.0, c.x, c.y, c.h, 0.0) is None
        existing.append(ExistingCard(x=x, y=y, h=200.0))
    # 앵커 주변 조밀(카드 중심이 앵커에서 멀지 않음)
    for c in existing:
        assert math.hypot((c.x + 210) - a0[0], (c.y + 100) - a0[1]) < 1400
```

- [ ] **Step 3: 실패 확인**

Run: `cd backend && uv run pytest tests/test_tag_placement.py -q`
Expected: FAIL — `ImportError: cannot import name 'tag_anchor'`.

- [ ] **Step 4: 구현 (ExistingCard.sim 기본값 + tag_anchor + place_by_tag)**

`canvas_layout.py`:
1) `ExistingCard.sim`에 기본값(태그 배치는 sim 불필요):
```python
@dataclass
class ExistingCard:
    x: float
    y: float
    h: float
    sim: float = 0.0
```
2) 상수·함수 추가(파일 하단, `_first_free_position` 뒤):
```python
_TAG_GOLDEN = math.radians(137.5)


def tag_anchor(k: int) -> tuple[float, float]:
    """태그 첫 등장 순서 k(0-based) → Vogel(해바라기) 나선 앵커(중앙 기준). 결정론.

    k=0 → 캔버스 중앙. k>0 → r=TAG_R0·√k, angle=k·137.5°로 부채꼴 분산.
    """
    cx, cy = CANVAS_W / 2.0, CANVAS_H / 2.0
    if k <= 0:
        return (cx, cy)
    r = _S.tag_r0 * math.sqrt(k)
    ang = k * _TAG_GOLDEN
    return (cx + r * math.cos(ang), cy + r * math.sin(ang))


def place_by_tag(
    anchor: tuple[float, float], existing: list[ExistingCard], new_h: float
) -> tuple[float, float]:
    """앵커를 카드 중심으로 두고, 기존 카드와 안 겹치는 가장 가까운 자리를 반환.

    같은 태그 카드는 같은 앵커에서 나선 확장 → 앵커 주변 조밀 클러스터.
    _first_free_position이 경계 클램프 + AABB 무겹침을 보장한다.
    """
    ax, ay = anchor
    px = ax - _S.card_w / 2.0   # 앵커=중심 → 좌상단 보정
    py = ay - new_h / 2.0
    return _first_free_position(px, py, new_h, existing)
```

- [ ] **Step 5: 통과 + 회귀**

Run: `cd backend && uv run pytest tests/test_tag_placement.py -q && uv run pytest -q`
Expected: 신규 통과, 기존 전부 통과(추가만, 기존 함수 유지).

- [ ] **Step 6: 커밋**
```bash
git add backend/app/config.py backend/app/services/canvas_layout.py backend/tests/test_tag_placement.py
git commit -m "$(cat <<'EOF'
[feat]: canvas_layout tag_anchor(Vogel 나선)+place_by_tag(무겹침 클러스터)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: EXAONE 프롬프트 — 분류 규칙 강화

**Files:** Modify `backend/app/services/exaone.py`

- [ ] **Step 1: 프롬프트 수정**

`CONCEPT_CARD_SYSTEM_PROMPT`의 분류 설명 줄(현재 `- "분류"는 관련 개념끼리 묶는 짧은 자유 분류어(스스로 정한다). 관련된 개념끼리는 같은 분류어를 재사용한다.`)을 아래로 교체:
```
- "분류"는 이 개념이 지도에서 어느 무리에 속하는지 나타내는 **안정적이고 성긴 대분류**다
  (예: 광합성, 지구계, 세포, 힘과 운동). 같은 주제·같은 무리의 개념은 반드시 **똑같은 분류어**를
  재사용한다 — 표기(띄어쓰기·동의어)를 매번 동일하게 맞춰라(예: "광합성"을 "광합성 과정"으로 바꾸지 마라).
  너무 세분화하지 말고, 서로 관련된 개념이 같은 분류로 묶이도록 넓게 잡는다.
```

- [ ] **Step 2: 검증(런타임, 스모크)**

Run: `cd backend && uv run pytest -q`
Expected: 회귀 없음(프롬프트 문자열 변경만).
Runtime(선택): dev 서버로 과학 질문 몇 개 → 응답의 `@concept: … | 분류`가 일관된 대분류를 재사용하는지 육안 확인(가능하면 `/tmp/nodi-e2e-QaXC/` 하네스로 SSE 토큰 로깅).

- [ ] **Step 3: 커밋**
```bash
git add backend/app/services/exaone.py
git commit -m "$(cat <<'EOF'
[feat]: 분류 프롬프트 강화 — 안정적 대분류·동일 표기 재사용(태그 배치용)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: chat.py/retrieve.py — 태그 배치 통합 (핵심)

**Files:** Modify `backend/app/routers/chat.py`, `backend/app/routers/retrieve.py`

**Interfaces:** Consumes T1 `parse`(cluster), T2 `tag_anchor`/`place_by_tag`, `svc.get_session_nodes`.

- [ ] **Step 1: chat.py 세션 상태 재구성 헬퍼 추가**

`chat.py`에 순수 헬퍼 추가(예: `_session_cards_as_existing` 부근):
```python
def _tag_state_from_nodes(
    nodes: list[dict],
) -> tuple[list[ExistingCard], dict[str, int]]:
    """세션 노드(created_at.asc)의 attachments.canvas.concepts[]에서
    기존 카드 rect + 태그 첫등장 순서를 재구성. is_navigator 제외.

    returns (existing_cards, tag_index={tag: k}). 빈 분류는 "기타".
    """
    cards: list[ExistingCard] = []
    tag_index: dict[str, int] = {}
    for n in nodes:
        if n.get("is_navigator"):
            continue
        canvas = (n.get("attachments") or {}).get("canvas") or {}
        for c in canvas.get("concepts") or []:
            tag = (c.get("tag") or "").strip() or "기타"
            if tag not in tag_index:
                tag_index[tag] = len(tag_index)
            x, y = c.get("x"), c.get("y")
            if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                h = c.get("h")
                cards.append(ExistingCard(
                    x=float(x), y=float(y),
                    h=float(h) if isinstance(h, (int, float)) else estimate_card_height(2),
                ))
    return cards, tag_index


def _place_tagged(
    tag: str, cards: list[ExistingCard], tag_index: dict[str, int], new_h: float
) -> tuple[float, float]:
    """태그 tag의 앵커에서 무겹침 배치. cards/tag_index를 in-place 갱신."""
    t = (tag or "").strip() or "기타"
    if t not in tag_index:
        tag_index[t] = len(tag_index)
    anchor = tag_anchor(tag_index[t])
    x, y = place_by_tag(anchor, cards, new_h)
    cards.append(ExistingCard(x=x, y=y, h=new_h))
    return x, y
```
Import 추가: `from ..services.canvas_layout import (…, tag_anchor, place_by_tag)`; `from ..services import sessions as svc`(이미 있으면 재사용).

- [ ] **Step 2: 스트림 시작 상태를 attachments에서 구성 + place에 태그 사용**

`event_stream` 진입부에서 `session_cards` scroll(canvas_cards) 대신 세션 노드로 태그 상태 구성. `chat_stream`(스트림 시작 전 컨텍스트 준비 구간, 현재 `session_cards = await _scroll_session_cards(...)` 위치)를 교체:
```python
    session_nodes = await svc.get_session_nodes(client, body.session_id)
    stream_cards, stream_tag_index = _tag_state_from_nodes(session_nodes)
```
`event_stream` 내부 place 상태를 태그 기반으로 교체 — `_session_pins`/`_pinned`/`_existing_cards`/`_next_place_event`(qvec 힘솔버)를 아래로 대체:
```python
        placed_coords: dict[int, tuple[float, float]] = {}
        placed_heights: dict[int, float] = {}
        placed_tags: dict[int, str] = {}
        concept_count = 0
        # 스트리밍 배치 상태(이번 답변 개념이 in-place로 합류)
        _live_cards = list(stream_cards)
        _live_tags = dict(stream_tag_index)

        def _next_place_event(tag: str) -> dict:
            nonlocal concept_count
            idx = concept_count
            concept_count += 1
            base_h = estimate_card_height(2)
            x, y = _place_tagged(tag, _live_cards, _live_tags, base_h)
            placed_coords[idx] = (x, y)
            placed_heights[idx] = base_h
            placed_tags[idx] = (tag or "").strip() or "기타"
            return {"concept_index": idx, "x": x, "y": y, "is_final": False}
```
그리고 `@concept:` 감지에서 태그를 추출해 넘긴다(2군데):
```python
                            m = _CONCEPT_LINE_RE.match(line)
                            if m:
                                _p = m.group(1).split("|")
                                _tag = _p[1].strip() if len(_p) > 1 else ""
                                yield _sse("place", _next_place_event(_tag))
```
```python
                _m = _CONCEPT_LINE_RE.match(line_buf.rstrip())
                if _m:
                    line_buf = ""
                    _p = _m.group(1).split("|")
                    _tag = _p[1].strip() if len(_p) > 1 else ""
                    yield _sse("place", _next_place_event(_tag))
```

- [ ] **Step 3: settle을 태그 배치로 교체 + concepts_meta에 tag**

done 훅 settle `try` 블록(현재 Part A passage 임베딩 루프)을 아래로 교체:
```python
                concepts_meta: list[dict] = []
                try:
                    parsed = concept_blocks.parse(answer)
                    settle_cards = list(stream_cards)      # 이번 답변 제외 원본
                    settle_tags = dict(stream_tag_index)
                    for block in parsed:
                        body_text = block["body"]
                        lines = body_text.count("\n") + 1 if body_text else 0
                        h = estimate_card_height(lines)
                        tag = (block.get("cluster") or "").strip() or "기타"
                        x, y = _place_tagged(tag, settle_cards, settle_tags, h)
                        placed_coords[block["index"]] = (x, y)
                        placed_heights[block["index"]] = h
                        concepts_meta.append({"i": block["index"], "x": x, "y": y, "h": h, "tag": tag})
                        yield _sse(
                            "place",
                            {"concept_index": block["index"], "x": x, "y": y, "is_final": True},
                        )
                except Exception:  # noqa: BLE001 - settle 실패 = 스트림/저장 무영향
                    logger.warning(
                        "done settle 실패 node=%s — 스트리밍 좌표로 폴백 저장",
                        node["id"], exc_info=True,
                    )
                    concepts_meta = []
```

- [ ] **Step 4: done 훅 저장 — 임베딩/canvas_cards 제거, attachments만**

settle 이후 저장부(현재 `_fill_missing_heights` + `asyncio.create_task(_save_canvas_cards(...))`)를 아래로 교체:
```python
                # settle 실패/부분 실패 폴백: 스트리밍 좌표+태그로 concepts_meta 보정
                if not concepts_meta and placed_coords:
                    for idx, (x, y) in placed_coords.items():
                        concepts_meta.append({
                            "i": idx, "x": x, "y": y,
                            "h": placed_heights.get(idx) or estimate_card_height(2),
                            "tag": placed_tags.get(idx, "기타"),
                        })

                # attachments.canvas 저장(concepts+tag + ebs/art) — 임베딩·canvas_cards 없음
                if concepts_meta:
                    asyncio.create_task(
                        _patch_canvas_unified(client, node["id"], concepts_meta, body.retrieved)
                    )
```
그리고 `_save_canvas_cards` 함수 정의는 **삭제**한다(임베딩+canvas_cards upsert 제거). `_fill_missing_heights`가 다른 곳에서 안 쓰이면 함께 삭제(안 쓰이면 eslint/flake 대비 제거; 쓰이면 유지).

- [ ] **Step 5: retrieve.py — near를 중앙 폴백으로(임베딩 near 제거)**

`retrieve.py` `_compute_near`(canvas_cards scroll + 코사인 + place_new_card)를 **삭제**하고, `retrieve` 핸들러에서 near를 중앙 상수로. ebs/art 검색(질의 임베딩)은 유지:
```python
    from ..services.canvas_layout import CANVAS_W, CANVAS_H
    ...
    # near: 태그는 답변 전 미지 → 중앙 폴백(첫 place가 태그 앵커로 이동)
    center = {"x": CANVAS_W / 2.0, "y": CANVAS_H / 2.0, "score": None}
    try:
        vec = await upstage.embed_query(question)
        ebs_hits, art_hits = await asyncio.gather(
            qdrant_store.search(qdrant_store.COL_EBS, vec, settings.retrieve_ebs_top_k,
                                score_threshold=settings.retrieve_ebs_min_score),
            qdrant_store.search(qdrant_store.COL_ART, vec, settings.retrieve_art_top_k,
                                score_threshold=settings.retrieve_art_min_score),
        )
    except Exception:  # noqa: BLE001
        logger.exception("retrieve failed — degraded 응답")
        return {"near": center, "ebs": [], "art": [], "degraded": True}
    return {"near": center, "ebs": _ebs_items(ebs_hits), "art": _art_items(art_hits), "degraded": False}
```
(빈 질문 분기의 near도 `center`로. `_compute_near`·`_cosine` 및 `canvas_layout` 배치 import 제거.)

- [ ] **Step 6: 백엔드 스위트 + 런타임**

Run: `cd backend && uv run pytest -q`
Expected: 통과(구 test_canvas_layout_force.py / test_chat_placement.py는 T5에서 정리 — 이 시점엔 아직 place_new_card가 존재하므로 통과. `_save_canvas_cards` 삭제로 그를 참조하는 테스트가 있으면 T5 전까지 실패할 수 있음 → 있으면 이 태스크에서 해당 참조만 제거).
Runtime(Playwright, `/tmp/nodi-e2e-QaXC/`): 같은 분류 유도 질문들 → 카드가 한 앵커로 모이고 다른 분류는 분리, 무겹침, 콘솔 에러 없음. 환경 제약 시 DONE_WITH_CONCERNS로 컨트롤러에 위임.

- [ ] **Step 7: 커밋**
```bash
git add backend/app/routers/chat.py backend/app/routers/retrieve.py
git commit -m "$(cat <<'EOF'
[feat]: 카드 배치를 태그 기반으로 — attachments 세션상태·tag_anchor 배치, 임베딩/canvas_cards near 제거

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 백엔드 데드코드·구 테스트 정리

**Files:** Modify `backend/app/services/canvas_layout.py`, `backend/app/config.py`; Delete/prune `backend/tests/test_canvas_layout_force.py`, `backend/tests/test_chat_placement.py`; Modify `backend/app/routers/chat.py`(잔여 import)

- [ ] **Step 1: canvas_layout에서 힘솔버 제거**

`target_distance`, `place_new_card`, 힘 이완 관련 상수(`force_*` 사용부) 및 `_aabb_push`(place_new_card 전용이면) 제거. **유지**: `ExistingCard`, `_overlap`, `_first_free_position`, `tag_anchor`, `place_by_tag`, `estimate_card_height`, `CANVAS_W/H`, `MARGIN`. `ExistingCard.sim` 필드 제거(기본값이라 참조부 없음 확인 후).
grep로 잔여 참조 확인: `grep -rn "place_new_card\|target_distance\|\.sim" backend/app` → 배치 경로에 없어야 함.

- [ ] **Step 2: _existing_for_vec + Part A 잔재 제거**

`chat.py`에서 `_existing_for_vec`, `_session_cards_as_existing`, `_scroll_session_cards`, `_cosine`(다른 사용처 없으면), `_place_for_new_concept` 등 배치 임베딩 잔재 제거. `qvec` 계산이 다른 곳(ebs/art)에서 안 쓰이면 제거. `config.py` `canvas_near_min_score` 제거.
grep: `grep -rn "canvas_near_min_score\|_existing_for_vec\|scroll_canvas_cards\|upsert_canvas_card" backend/app` → 배치 경로에 없어야 함(qdrant_store 정의는 미사용으로 남겨도 됨).

- [ ] **Step 3: 구 테스트 정리**

`test_canvas_layout_force.py`: `place_new_card`/`target_distance` 테스트 삭제, 무겹침(`_overlap`/`_first_free_position`) 테스트만 남기거나 파일 삭제(무겹침은 test_tag_placement가 커버). `test_chat_placement.py`(Part A `_existing_for_vec`) 삭제.

- [ ] **Step 4: 스위트 통과**

Run: `cd backend && uv run pytest -q`
Expected: 통과(데드코드·구 테스트 제거 후). import 에러 없음.

- [ ] **Step 5: 커밋**
```bash
git add backend/app/services/canvas_layout.py backend/app/config.py backend/app/routers/chat.py backend/tests/test_canvas_layout_force.py backend/tests/test_chat_placement.py
git commit -m "$(cat <<'EOF'
[refactor]: 힘솔버·임베딩 배치 데드코드/구 테스트 제거(태그 배치로 대체)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
(삭제 파일은 `git add`에 경로를 포함하면 삭제가 스테이징됨.)

---

## Task 6: 프론트 — tag 스키마 허용 + 첫 place 포커스 재조정

**Files:** Modify `frontend/src/lib/concept/useConceptStream.ts`

- [ ] **Step 1: PersistedCanvas.concepts에 tag 허용**

`PersistedCanvas`의 `concepts?` 항목 타입에 `tag?: string` 추가(파싱만; 렌더는 좌표 사용):
```ts
  concepts?: Array<{ i?: number; x?: number; y?: number; h?: number; tag?: string }>;
```
(coordMap 구성부는 x/y/h만 쓰므로 변경 불필요 — 방어적 파싱만.)

- [ ] **Step 2: 첫 place에 자동포커싱 재조정**

`onPlace`(현재 `localIdx === 0 && pendingIdRef.current`에서 placeholder 좌표만 이동)에서, 이번 답변 첫 개념(concept_index 0)의 **비최종 place**가 오면 카메라 포커스도 그 좌표로 재조정한다. `focusSignal`을 갱신할 방법이 hook 내부이므로, `setFocusSignal`을 재사용:
```ts
          onPlace: (p: PlaceEvent) => {
            const localIdx = p.concept_index;
            pendingCoordsRef.current.set(localIdx, { x: p.x, y: p.y });
            if (!p.is_final && localIdx === 0) {
              // 태그 앵커로 카드가 이동 → 카메라도 그 지점으로 재포커스(near=중앙 폴백 보정)
              setFocusSignal({ x: p.x, y: p.y, key: ++focusKeyRef.current });
            }
            if (p.is_final) { /* 기존 최종 좌표 반영 로직 유지 */ }
            if (localIdx === 0 && pendingIdRef.current) { /* 기존 placeholder 이동 유지 */ }
          },
```
(기존 `onPlace` 본문은 유지하고 위 재포커스 분기만 추가. `setFocusSignal`/`focusKeyRef`는 이미 존재.)

- [ ] **Step 3: 타입/린트**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/lib/concept/useConceptStream.ts`
Expected: EXIT 0.

- [ ] **Step 4: Playwright — 태그 클러스터 + 재현**

Run: `node /tmp/nodi-e2e-QaXC/…`(같은 분류 3질문→한 앵커 조밀 / 다른 분류→분리 / 무겹침 / 새로고침 재현). 환경 제약 시 DONE_WITH_CONCERNS.

- [ ] **Step 5: 커밋**
```bash
git add frontend/src/lib/concept/useConceptStream.ts
git commit -m "$(cat <<'EOF'
[feat]: 프론트 tag 스키마 허용 + 첫 place에 카메라 재포커스(태그 앵커)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- §2 태그 소스(cluster 파싱·프롬프트) → T1·T3. ✓
- §3 tag_anchor·place_by_tag·무겹침, 힘솔버 제거 → T2(추가)·T5(제거). ✓
- §4 attachments 세션상태·canvas_cards/임베딩 제거·tag 저장 → T4. ✓
- §5 near 중앙 폴백·첫 place 포커스 → T4 Step5·T6. ✓
- §9 테스트(tag_anchor/place_by_tag/parse 유닛, E2E) → T1·T2·T4·T6. ✓
- §10 비범위 준수(미니맵 태그그룹핑·정규화·컬렉션 삭제·Part B 제외). ✓

**2. Placeholder scan:** 코드 스텝에 실제 코드. T5는 "제거" 작업이라 grep 확인 명령으로 구체화(파일 전체 재출력 대신 대상·검증 명시) — 삭제 태스크의 성격상 허용. ✓

**3. Type consistency:**
- `tag_anchor(k)->(x,y)`, `place_by_tag(anchor, existing, new_h)->(x,y)` — T2 정의 ↔ T4 `_place_tagged` 사용 일치. ✓
- `parse`가 `cluster` 반환 — T1 ↔ T4 settle(`block["cluster"]`) 일치. ✓
- `concepts_meta` 항목 `{i,x,y,h,tag}` — T4 저장 ↔ T6 `PersistedCanvas.concepts[].tag` 일치. ✓
- `ExistingCard(x,y,h)`(sim 기본값) — T2 ↔ T4 `_tag_state_from_nodes`/`_place_tagged` 일치. ✓
- `svc.get_session_nodes` (attachments 포함, created_at.asc) — 확인된 시그니처. ✓

**주의(실행 시):** T4는 `_save_canvas_cards` 삭제를 포함하므로, 그 함수를 참조하는 잔여(예: 다른 테스트)가 있으면 T4에서 참조 제거, 본격 데드코드 정리는 T5. 각 태스크 종료 시 `uv run pytest -q`로 green 확인.
