# 질의→응답 임베딩 위치 보정 · 맵당 리프 1개 대표 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) 카드 최종 위치를 done 시점의 응답 passage 임베딩으로 보정(초기 배치는 질의 임베딩 유지)하고, (B) EBS 영상·삽화 리프를 맵당 각 1개로 제한해 최고 스코어 후보를 대표로 갱신한다.

**Architecture:** Part A는 `chat.py` settle에서 저장용으로 이미 계산하던 응답 passage 임베딩을 **앞당겨** 위치 계산에 재사용한다(개념별 passage 벡터로 대칭 유사도 → `place_new_card`). Part B는 백엔드 저장 구조를 바꾸지 않고(각 노드가 자기 후보+스코어를 계속 저장), 프론트에서 세션 전체 후보의 argmax(score)로 영상 1·삽화 1만 렌더·갱신한다.

**Tech Stack:** FastAPI + Upstage embeddings(비대칭 query/passage) + Qdrant(canvas_cards), Next.js 16/React 19. 백엔드는 pytest, 프론트는 tsc/eslint + Playwright.

## Global Constraints

- **초기 배치는 질의 임베딩 유지**: 스트리밍 중(`_place_for_new_concept` / `_session_cards_as_existing(session_cards, qvec)`) 배치는 그대로. 오직 **settle(done)** 만 응답 passage 벡터로 보정한다.
- **재임베딩 금지**: settle에서 계산한 passage 벡터를 `_save_canvas_cards`가 재사용한다(같은 개념을 두 번 임베딩하지 않는다).
- **self-격리 유지**: settle(파싱/임베딩/솔버) 실패는 `logger.warning`만, error SSE 방출 금지, 스트리밍 좌표(`placed_coords`, 질의 기반)로 폴백 저장. 임베딩 실패 시 `_save_canvas_cards`는 자체 임베딩으로 폴백.
- **`_cosine`는 [0,1] 클램프**(기존): 음수 0. sim은 `ExistingCard.sim`으로 그대로 사용.
- **맵당 리프 = 영상 1 + 삽화 1**: 최고 `score` 후보만 렌더. 라이브는 `후보.score > 현재 대표 score`일 때만 교체; 재수화는 전 노드 argmax(score), 동점은 첫 노드. 리프 id 고정(`map-video`/`map-art`)로 이동/교체.
- **리프 무겹침 유지**: 대표 리프는 앵커 개념 곁에 기존 `placeLeafClear`로 카드·상대 리프와 겹치지 않게 배치.
- **저장 스키마 불변**: 각 노드는 자기 retrieve 후보(ebs/art + score)를 계속 `attachments.canvas`에 저장(재수화 argmax 입력). 프론트가 렌더 시 1개 선택.
- **`git add`는 명시 경로만**(레포에 무관 미추적 파일 다수 — `git add -A` 금지). 커밋 트레일러: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **(프로세스) 서브에이전트는 opus 4.8 사용.**

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `backend/app/routers/chat.py` | 스트림/배치/저장 | `_existing_for_vec` 신설; settle 응답 임베딩 보정; `_save_canvas_cards` 벡터 재사용 |
| `backend/tests/test_chat_placement.py` | 단위 테스트 | **신설** — `_existing_for_vec` |
| `backend/app/config.py` | 설정 | `retrieve_art_top_k` 2→1 |
| `frontend/src/lib/concept/useConceptStream.ts` | 스트림/재수화 | 리프 스폰 → 맵당 단일 대표(라이브 교체 + 재수화 argmax) |

백엔드 테스트: `cd backend && uv run pytest -q`. 프론트: `npx tsc --noEmit` + `npx eslint` + Playwright(`/tmp/nodi-e2e-QaXC/`).

---

## Task 1: `_existing_for_vec` 순수 헬퍼 + 단위 테스트 (Part A 기반)

**Files:**
- Modify: `backend/app/routers/chat.py` (`_session_cards_as_existing` 근처에 추가)
- Create: `backend/tests/test_chat_placement.py`

**Interfaces:**
- Produces: `_existing_for_vec(session_cards: list[dict], placed: list[tuple[float,float,float,list[float]]], vec: list[float]) -> list[ExistingCard]`.

- [ ] **Step 1: 실패 테스트 작성**

`backend/tests/test_chat_placement.py`:
```python
from app.routers.chat import _existing_for_vec


def test_existing_for_vec_cosine_session_and_placed():
    session_cards = [
        {"payload": {"x": 100, "y": 100, "size_h": 200}, "vector": [1.0, 0.0]},
        {"payload": {"x": 200, "y": 200, "size_h": 200}, "vector": [0.0, 1.0]},
        {"payload": {"x": 300, "y": 300}, "vector": []},  # 벡터 없음 → sim 0
    ]
    placed = [(400.0, 400.0, 160.0, [1.0, 0.0])]  # 같은 답변에서 이미 배치된 개념
    vec = [1.0, 0.0]  # 배치할 개념의 passage 벡터

    out = _existing_for_vec(session_cards, placed, vec)

    assert len(out) == 4
    assert out[0].sim == 1.0   # 동일 방향
    assert out[1].sim == 0.0   # 직교
    assert out[2].sim == 0.0   # 벡터 없음
    assert out[0].x == 100.0 and out[0].h == 200.0
    # placed 개념도 대칭 코사인으로 포함
    assert out[3].sim == 1.0 and out[3].x == 400.0 and out[3].h == 160.0


def test_existing_for_vec_empty():
    assert _existing_for_vec([], [], [1.0, 0.0]) == []
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && uv run pytest tests/test_chat_placement.py -q`
Expected: FAIL — `ImportError: cannot import name '_existing_for_vec'`.

- [ ] **Step 3: `_existing_for_vec` 구현**

`chat.py`에서 `_session_cards_as_existing` 정의 **바로 아래**에 추가:
```python
def _existing_for_vec(
    session_cards: list[dict],
    placed: list[tuple[float, float, float, list[float]]],
    vec: list[float],
) -> list[ExistingCard]:
    """settle 위치 보정용 pin 목록 — 배치할 개념의 passage 벡터 `vec` 기준.

    각 기존 세션 카드 sim = cosine(vec, 카드 passage벡터); 같은 답변에서 이미 배치된
    개념 placed=[(x,y,h,pvec)]도 sim = cosine(vec, pvec)로 포함(고정 0.9 대신 대칭).
    벡터 없는 카드는 sim=0.0. 결정론(입력 순서 보존).
    """
    out: list[ExistingCard] = []
    for c in session_cards:
        pl = c.get("payload") or {}
        cvec = c.get("vector") or []
        sim = _cosine(vec, cvec) if (vec and cvec) else 0.0
        out.append(
            ExistingCard(
                x=float(pl.get("x", 0.0)),
                y=float(pl.get("y", 0.0)),
                h=float(pl.get("size_h") or estimate_card_height(2)),
                sim=sim,
            )
        )
    for (x, y, h, pvec) in placed:
        sim = _cosine(vec, pvec) if (vec and pvec) else 0.0
        out.append(ExistingCard(x=x, y=y, h=h, sim=sim))
    return out
```

- [ ] **Step 4: 통과 확인**

Run: `cd backend && uv run pytest tests/test_chat_placement.py -q`
Expected: `2 passed`.

- [ ] **Step 5: 커밋**

```bash
git add backend/app/routers/chat.py backend/tests/test_chat_placement.py
git commit -m "$(cat <<'EOF'
[feat]: _existing_for_vec — settle 위치 보정용 passage 대칭 유사도 pin

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: settle 응답 임베딩 위치 보정 (Part A 통합)

**Files:**
- Modify: `backend/app/routers/chat.py` (settle 루프; `_save_canvas_cards` 시그니처·본문; settle 호출부)

**Interfaces:**
- Consumes: Task 1 `_existing_for_vec`, 기존 `upstage.embed_passages`, `place_new_card`, `concept_blocks.parse`.
- Produces: `_save_canvas_cards(..., precomputed_vectors: dict[int, list[float]] | None = None)`.

- [ ] **Step 1: settle 루프를 응답 passage 벡터 기반으로 교체**

`chat.py` done 훅의 settle `try` 블록(현재 `parsed = concept_blocks.parse(answer)` … place is_final 루프)을 아래로 교체. `settle_vecs`는 try 밖에서 선언(폴백 대비):
```python
                # settle 재배치에 쓴 개념별 passage 벡터(저장에서 재사용 → 재임베딩 방지)
                settle_vecs: dict[int, list[float]] = {}
                try:
                    parsed = concept_blocks.parse(answer)
                    # Part A: 응답 passage 임베딩을 settle에서 선계산(저장과 공유).
                    texts = [f"{b['title']}\n{b['body']}" for b in parsed]
                    pvecs = await upstage.embed_passages(texts) if texts else []
                    placed: list[tuple[float, float, float, list[float]]] = []
                    for block, pvec in zip(parsed, pvecs):
                        body_text = block["body"]
                        lines = body_text.count("\n") + 1 if body_text else 0
                        h = estimate_card_height(lines)
                        # 응답 개념↔개념 대칭 유사도로 위치 보정(질의 임베딩 아님).
                        existing_i = _existing_for_vec(session_cards, placed, pvec)
                        x, y = place_new_card(h, existing_i, len(existing_i))
                        placed_coords[block["index"]] = (x, y)
                        placed_heights[block["index"]] = h
                        placed.append((x, y, h, pvec))
                        settle_vecs[block["index"]] = pvec
                        yield _sse(
                            "place",
                            {
                                "concept_index": block["index"],
                                "x": x,
                                "y": y,
                                "is_final": True,
                            },
                        )
                except Exception:  # noqa: BLE001 - settle 실패 = 스트림/저장 무영향
                    logger.warning(
                        "done settle 실패 node=%s — 스트리밍 좌표로 폴백 저장",
                        node["id"],
                        exc_info=True,
                    )
```

- [ ] **Step 2: `_save_canvas_cards`가 settle 벡터를 재사용하도록 수정**

`_save_canvas_cards` 시그니처에 `precomputed_vectors` 추가하고, 전량 제공 시 재임베딩 생략. 현재 본문(`texts`/`vectors` 계산 + `for b, vec in zip(blocks, vectors)`)을 아래로 교체:
```python
async def _save_canvas_cards(
    client: UserClient,
    user_id: str,
    session_id: str,
    node_id: str,
    answer: str,
    placed_coords: dict[int, tuple[float, float]],
    placed_heights: dict[int, float],
    retrieved: RetrievedBody | None = None,
    precomputed_vectors: dict[int, list[float]] | None = None,
) -> None:
    """done 훅 — 개념 임베딩 + canvas_cards upsert + attachments 병합.

    settle이 이미 계산한 passage 벡터(precomputed_vectors)가 전 개념을 덮으면
    재임베딩하지 않고 재사용한다. 아니면(폴백) 여기서 embed_passages로 계산한다.
    실패는 logger.warning만 — 스트림/답변 저장에 영향 없음.
    """
    try:
        blocks = concept_blocks.parse(answer)
        if not blocks:
            return

        pv = precomputed_vectors or {}
        if all(b["index"] in pv for b in blocks):
            vectors_by_idx = pv  # settle 벡터 재사용(재임베딩 없음)
        else:
            texts = [f"{b['title']}\n{b['body']}" for b in blocks]
            embedded = await upstage.embed_passages(texts)
            vectors_by_idx = {b["index"]: embedded[k] for k, b in enumerate(blocks)}

        concepts_meta: list[dict] = []
        for b in blocks:
            idx = b["index"]
            vec = vectors_by_idx.get(idx)
            coord = placed_coords.get(idx)
            if vec is None or coord is None:
                continue  # 벡터/좌표 없는 개념 스킵
            x, y = coord
            h = placed_heights.get(idx) or estimate_card_height(2)
            await qdrant_store.upsert_canvas_card(
                owner_id=user_id,
                session_id=session_id,
                node_id=node_id,
                concept_index=idx,
                title=b["title"],
                x=x,
                y=y,
                size_h=h,
                vector=vec,
            )
            concepts_meta.append({"i": idx, "x": x, "y": y, "h": h})

        if concepts_meta:
            await _patch_canvas_unified(client, node_id, concepts_meta, retrieved)

    except Exception:  # noqa: BLE001
        logger.warning(
            "canvas_cards 저장 실패 node=%s — 다음 kNN에서 해당 카드 누락",
            node_id,
            exc_info=True,
        )
```

- [ ] **Step 3: settle 호출부에서 `precomputed_vectors` 전달**

done 훅의 `asyncio.create_task(_save_canvas_cards(...))` 호출에 인자 추가:
```python
                if placed_coords:
                    asyncio.create_task(
                        _save_canvas_cards(
                            client,
                            user_id=user.id,
                            session_id=body.session_id,
                            node_id=node["id"],
                            answer=answer,
                            placed_coords=placed_coords,
                            placed_heights=placed_heights,
                            retrieved=body.retrieved,
                            precomputed_vectors=settle_vecs,
                        )
                    )
```

- [ ] **Step 4: 백엔드 스위트 통과**

Run: `cd backend && uv run pytest -q`
Expected: 전부 통과(기존 + `test_chat_placement.py` 2건). 회귀 없음.

- [ ] **Step 5: Playwright — Part A 관찰(런타임)**

같은 개념을 다르게 물어 두 카드가 가깝게 안착하는지, done 시 카드가 초기→보정 위치로 이동하는지 확인:
```js
// Q1, Q2를 순차 질의(같은 개념 다른 표현) 후 두 카드 좌표 거리 측정
const cards = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="concept-card"]')]
    .map(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) })));
const d = Math.hypot(cards[0].x - cards[1].x, cards[0].y - cards[1].y);
console.log('같은 개념 두 카드 거리', Math.round(d)); // 조밀(수백 px 이내) 기대
```
Expected: 같은 개념 두 카드가 조밀하게 안착(멀리 흩어지지 않음). 콘솔 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add backend/app/routers/chat.py
git commit -m "$(cat <<'EOF'
[feat]: settle 위치를 응답 passage 임베딩으로 보정(재임베딩 재사용)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 맵당 리프 1개 대표 (Part B)

**Files:**
- Modify: `backend/app/config.py` (`retrieve_art_top_k` 2→1)
- Modify: `frontend/src/lib/concept/useConceptStream.ts` (라이브 대표 갱신 + 재수화 argmax)

**Interfaces:**
- Consumes: 기존 `cardRect/leafRect/LEAF_DIMS/placeLeafClear/Rect`(이미 import됨), `commitLeafNodes`, `leafNodesRef`, `conceptsRef`.

- [ ] **Step 1: 삽화 후보 1개로 축소**

`backend/app/config.py`:
```python
    retrieve_art_top_k: int = 1
```

- [ ] **Step 2: 대표 스코어 ref 추가**

`useConceptStream.ts` ref 블록(예: `leafNodesRef` 근처)에 추가:
```ts
  // Part B: 맵당 영상 1·삽화 1 — 현재 대표의 최고 스코어(교체 판정 기준선).
  // 세션 동안 유지, 재수화 시 로드된 대표 스코어로 재설정.
  const mapVideoScoreRef = useRef<number>(-Infinity);
  const mapArtScoreRef = useRef<number>(-Infinity);
```

- [ ] **Step 3: 라이브 리프 스폰을 단일 대표 갱신으로 교체**

`send`의 리프 배치 블록(현재 `const batch: CanvasLeafNode[] = []; …; batch.forEach(스태거 스폰)` 전체)을 아래로 교체. 실패 롤백용 스냅샷도 잡는다:
```ts
      // (c) Part B: 맵당 영상 1·삽화 1 — 최고 스코어 후보만 대표로 유지/교체.
      // 스트림 실패 시 되돌리기 위한 스냅샷.
      const leafSnapshot = leafNodesRef.current;
      const scoreSnapshot = {
        v: mapVideoScoreRef.current,
        a: mapArtScoreRef.current,
      };
      const placeRep = (
        id: "map-video" | "map-art",
        type: CanvasLeafNode["type"],
        extra: Partial<CanvasLeafNode>,
      ) => {
        const d = LEAF_DIMS[type];
        const others = leafNodesRef.current.filter((n) => n.id !== id);
        const obstacles: Rect[] = [
          ...conceptsRef.current.map(cardRect),
          ...others.map(leafRect),
        ];
        const { x, y } = placeLeafClear(
          nearXY.x + LEAF_OFFSET_X,
          nearXY.y,
          d.w,
          d.h,
          obstacles,
        );
        commitLeafNodes([...others, { id, type, x, y, conceptId: pid, ...extra }]);
      };
      const repVideo = r.ebs[0];
      if (repVideo && typeof repVideo.score === "number" && repVideo.score > mapVideoScoreRef.current) {
        mapVideoScoreRef.current = repVideo.score;
        placeRep("map-video", "video", {
          video: { videoId: repVideo.videoId, title: repVideo.title, thumb: repVideo.thumb },
        });
      }
      const repArt = r.art[0];
      if (repArt && typeof repArt.score === "number" && repArt.score > mapArtScoreRef.current) {
        mapArtScoreRef.current = repArt.score;
        placeRep("map-art", "art", {
          art: { slug: repArt.slug, url: repArt.url, title: repArt.title },
        });
      }
```
그리고 `send` 내 리프 관련 잔재 정리: 더 이상 쓰지 않는 `spawnedLeafIds`·`localTimers`(리프 스태거)·`LEAF_SPAWN_STAGGER_MS` 참조/선언을 제거해 eslint(no-unused)를 통과시킨다. (`spawnTimersRef`는 재수화 정리에서 여전히 참조되므로 유지 — 항상 비어 있어도 무해.)

- [ ] **Step 4: 스트림 실패 시 대표 롤백**

`send`의 스트림 실패 정리 블록(현재 `if (!doneBox.current && spawnedLeafIds.size) { … 리프 회수 … }`)을 아래로 교체:
```ts
      // 스트림 실패(done 미수신) 시 이번 send의 대표 교체를 되돌린다.
      if (!doneBox.current) {
        commitLeafNodes(leafSnapshot);
        mapVideoScoreRef.current = scoreSnapshot.v;
        mapArtScoreRef.current = scoreSnapshot.a;
      }
```

- [ ] **Step 5: 재수화를 전 노드 argmax(score)로 교체**

재수화의 리프 재생성 블록(현재 `const leaves: CanvasLeafNode[] = []; const obstacles = built.map(cardRect); for (const n of reals) { … pushLeaf … }`)을 아래로 교체:
```ts
    // Part B: 전 노드 후보 중 최고 스코어로 영상 1·삽화 1 결정(argmax, 동점=첫 노드).
    let bestVideo: { score: number; nodeId: string; e: NonNullable<PersistedCanvas["ebs"]>[number] } | null = null;
    let bestArt: { score: number; nodeId: string; a: NonNullable<PersistedCanvas["art"]>[number] } | null = null;
    for (const n of reals) {
      const canvas = (n as NodeRowWithAttachments).attachments?.canvas;
      if (!canvas) continue;
      for (const e of canvas.ebs ?? []) {
        if (!e?.video_id || typeof e.score !== "number") continue;
        if (!bestVideo || e.score > bestVideo.score) bestVideo = { score: e.score, nodeId: n.id, e };
      }
      for (const a of canvas.art ?? []) {
        if (!a?.slug || typeof a.score !== "number") continue;
        if (!bestArt || a.score > bestArt.score) bestArt = { score: a.score, nodeId: n.id, a };
      }
    }
    const leaves: CanvasLeafNode[] = [];
    const obstacles: Rect[] = built.map(cardRect);
    const anchorXY = (nodeId: string) => {
      const idx = firstIdxByNode.get(nodeId);
      const anchor = idx == null ? undefined : built[idx];
      return anchor ? { x: anchor.x, y: anchor.y, id: anchor.id } : { x: 40, y: 40, id: undefined };
    };
    if (bestVideo) {
      const base = anchorXY(bestVideo.nodeId);
      const d = LEAF_DIMS.video;
      const { x, y } = placeLeafClear(base.x + LEAF_OFFSET_X, base.y, d.w, d.h, obstacles);
      obstacles.push({ x, y, w: d.w, h: d.h });
      leaves.push({
        id: "map-video", type: "video", x, y, conceptId: base.id,
        video: {
          videoId: String(bestVideo.e.video_id),
          title: bestVideo.e.title ?? "",
          thumb: bestVideo.e.thumb ?? `https://i.ytimg.com/vi/${bestVideo.e.video_id}/hqdefault.jpg`,
        },
      });
      mapVideoScoreRef.current = bestVideo.score;
    } else {
      mapVideoScoreRef.current = -Infinity;
    }
    if (bestArt) {
      const base = anchorXY(bestArt.nodeId);
      const d = LEAF_DIMS.art;
      const { x, y } = placeLeafClear(base.x + LEAF_OFFSET_X, base.y, d.w, d.h, obstacles);
      obstacles.push({ x, y, w: d.w, h: d.h });
      leaves.push({
        id: "map-art", type: "art", x, y, conceptId: base.id,
        art: {
          slug: String(bestArt.a.slug),
          url: bestArt.a.url ?? `/art/${bestArt.a.slug}.svg`,
          title: bestArt.a.title ?? "",
        },
      });
      mapArtScoreRef.current = bestArt.score;
    } else {
      mapArtScoreRef.current = -Infinity;
    }
```

- [ ] **Step 6: 타입/린트 통과**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/lib/concept/useConceptStream.ts`
Expected: EXIT 0(제거한 스태거 잔재로 인한 no-unused 없음).

- [ ] **Step 7: Playwright — Part B 관찰(런타임)**

다주제 질문 3~4개 후 맵에 영상·삽화가 각각 정확히 1개인지, 새로고침 후에도 1개인지 확인:
```js
const counts = await page.evaluate(() => ({
  video: document.querySelectorAll('[data-testid="video-node"]').length,
  art: document.querySelectorAll('[data-testid="art-node"]').length,
}));
console.log('라이브 리프', counts); // { video: <=1, art: <=1 }
await page.reload({ waitUntil: 'networkidle' });
// 세션 재선택(드로어) 후 재측정
```
Expected: 라이브 `video ≤ 1, art ≤ 1`(맵당 각 1개); 재수화 후에도 동일. (후보가 임계 미달인 세션은 0개 가능.)

- [ ] **Step 8: 커밋**

```bash
git add backend/app/config.py frontend/src/lib/concept/useConceptStream.ts
git commit -m "$(cat <<'EOF'
[feat]: 맵당 EBS 영상·삽화 각 1개 대표(최고 스코어 갱신, art_top_k 2→1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- §2 Part A 초기 질의/ settle 응답 보정, `_existing_for_vec`, 재임베딩 재사용, self-격리 폴백 → Task 1 + Task 2. ✓
- §3 Part B 최고 스코어 대표, 라이브 교체, 재수화 argmax, art_top_k=1, 무겹침 앵커 → Task 3. ✓
- §7-1 `_existing_for_vec` 유닛 → Task 1 Step 1. §7-2 E2E Part A/B → Task 2 Step 5, Task 3 Step 7. ✓
- §8 비범위 준수(스트리밍은 질의 기반; near 불변; 저장 스키마 불변). ✓
- 갭 없음.

**2. Placeholder scan:** "TBD/TODO/적절히" 없음. 모든 코드 스텝에 실제 코드. ✓

**3. Type consistency:**
- `_existing_for_vec(session_cards, placed:[(x,y,h,pvec)], vec)` — Task 1 정의 ↔ Task 2 settle 호출(`_existing_for_vec(session_cards, placed, pvec)`) 일치. ✓
- `_save_canvas_cards(..., precomputed_vectors)` — Task 2 Step 2 정의 ↔ Step 3 호출 일치. ✓
- `placeRep`/argmax가 쓰는 `LEAF_DIMS/cardRect/leafRect/placeLeafClear/Rect`·`PersistedCanvas.ebs/art[].score`·`firstIdxByNode`·`built` — 기존 정의와 일치(이전 피처에서 도입). ✓
- 리프 id `map-video`/`map-art` — 라이브(Task 3 Step 3)·재수화(Step 5) 동일. ✓
