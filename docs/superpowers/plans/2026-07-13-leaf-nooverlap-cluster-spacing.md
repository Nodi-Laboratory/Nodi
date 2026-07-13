# 리프 무겹침 배치 + 주제 클러스터 분리 간격 확대 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개념 카드 곁 리프(영상추천·삽화)가 어떤 응답 카드와도 겹치지 않게 나선 무겹침 배치로 바꾸고, 서로 다른 주제(클러스터)가 더 멀리 분리되도록 배치 간격을 넓힌다.

**Architecture:** (1) 서버 힘-솔버의 최대 목표거리 `D_MAX`를 키우고 배치 영역(CANVAS)을 함께 확장해 클램프에 잘리지 않게 한다. (2) 프론트에 순수 헬퍼 `leafPlacement.ts`를 신설 — 개념 카드/기존 리프를 AABB 장애물로 삼아 선호 위치에서 나선 탐색으로 겹치지 않는 가장 가까운 자리를 찾는다(서버 `_first_free_position` 이식). (3) 라이브 스폰·재수화 양쪽에서 동일 헬퍼로 리프 좌표를 확정한다.

**Tech Stack:** FastAPI + pydantic-settings(backend config), 순수 파이썬 기하(canvas_layout), Next.js 16 / React 19 / TypeScript(frontend), Playwright E2E(프론트 검증 — 프론트 유닛 러너 없음).

## Global Constraints

- **좌표계는 좌상단 기준**: 프론트는 `style.left/top = (x,y)`를 카드/리프의 **좌상단**으로 렌더한다. 모든 충돌 판정은 좌상단 기준 AABB여야 한다(외접원·중심 기준 금지 — 가변 높이에서 겹침 유발).
- **결정론**: 배치에 `Math.random()`·난수 미사용. 같은 입력 → 같은 좌표.
- **캔버스 무한 팬**: 리프 배치에는 경계 클램프 없음(카드 솔버만 CANVAS 범위로 클램프).
- **최소 간격 `MIN_GAP = 24px`**: 카드↔카드, 카드↔리프, 리프↔리프 모두 이 여백 이상 유지.
- **리프 크기(px, 과대추정 = 안전)**: 영상 340×132, 삽화 220×210.
- **카드 크기**: 폭 420 고정, 높이 = 서버 저장 `concept.h` 우선, 없으면 `clamp(160 + (본문 p블록 수)·28, 160, 560)` (ConceptCard.cardHeight와 동일 계산; pending은 2줄 가정).
- **git add는 명시 경로만**: 레포에 사용자의 커밋 전 미추적 파일이 다수 존재 — `git add -A` 절대 금지.
- **커밋 트레일러**: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **(프로세스) 서브에이전트는 opus 4.8 사용.**

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `backend/app/config.py` | 힘-솔버 상수 | `force_d_max` 1200→1500 |
| `backend/app/services/canvas_layout.py` | 카드 배치 영역·솔버 | `CANVAS_W/H` 2600/1600→3200/2200 |
| `frontend/src/components/canvas/NoteCanvas.tsx` | 캔버스 표면(팬/줌) 크기 | `CANVAS_W/H` 동기 확장 |
| `frontend/src/lib/concept/layout.ts` | 레이아웃 상수(LAYOUT) | `CANVAS_W/H` 동기 확장 |
| `frontend/src/lib/concept/leafPlacement.ts` | **신설** — 리프 AABB 무겹침 나선 배치 | Create |
| `frontend/src/lib/concept/useConceptStream.ts` | 스트리밍/재수화 배치 | 리프 좌표를 `placeLeafClear`로 확정(양쪽) |

**테스트 도구 주의:** 프론트엔드에는 유닛 테스트 러너(jest/vitest)가 **없다**. 프론트 검증은 `npx tsc --noEmit`(타입) + `npx eslint`(린트) + **Playwright E2E**(런타임 무겹침 관찰)로 한다. 백엔드는 `pytest`.

---

## Task 1: 주제 클러스터 분리 간격 확대 (D_MAX + 캔버스 확장)

**Files:**
- Modify: `backend/app/config.py:65`
- Modify: `backend/app/services/canvas_layout.py:20-21`
- Modify: `frontend/src/components/canvas/NoteCanvas.tsx:15-16`
- Modify: `frontend/src/lib/concept/layout.ts:13-14`
- Test: `backend/tests/test_canvas_layout_force.py` (기존 — 상수 심볼릭 참조라 그대로 통과)

**Interfaces:**
- Consumes: `get_settings().force_d_max`, `canvas_layout.CANVAS_W/CANVAS_H`.
- Produces: 없음(상수만 변경). `place_new_card`/`target_distance` 시그니처 불변.

**배경:** `target_distance(sim<S_MIN) = D_MAX`가 다른 주제 간 목표거리다. 그런데 배치 영역이 세로로 타이트해(`CANVAS_H=1600`, 중심 y=800 → 세로 가용 ±약 610px < D_MAX) 큰 거리가 클램프에 잘렸다. D_MAX를 키우고 CANVAS를 함께 넓혀야 실제 분리가 커진다.

- [ ] **Step 1: 회귀 가드 테스트가 상수에 독립적인지 확인(실패 아님, 사전 점검)**

`test_first_card_is_center`는 `place_new_card(200.0, [], 0) == (CANVAS_W/2, CANVAS_H/2)`로 **모듈 상수를 import**해 비교하므로 값 변경에 자동 적응한다. `test_target_distance_*`, `test_dissimilar_pushed_far`도 `S.force_d_max`를 심볼릭 참조한다. 하드코딩된 2600/1600/1200이 없어야 한다.

Run: `cd backend && grep -nE "2600|1600|1200" tests/test_canvas_layout_force.py`
Expected: 출력 없음(하드코딩 상수 부재 → 값 변경이 테스트를 깨지 않음).

- [ ] **Step 2: 백엔드 상수 변경**

`backend/app/config.py` (force 상수 블록):
```python
    force_d_max: float = 1500.0      # 최대 목표 거리(px) — 주제(클러스터)간 간격
```

`backend/app/services/canvas_layout.py` (상수 블록):
```python
CANVAS_W = 3200
CANVAS_H = 2200
MARGIN = 40
```

- [ ] **Step 3: 프론트 캔버스 표면 크기 동기화**

카드가 확장된 영역에 배치돼도 표면(팬 대상 div) 안에 들도록 맞춘다.

`frontend/src/components/canvas/NoteCanvas.tsx`:
```tsx
export const CANVAS_W = 3200;
export const CANVAS_H = 2200;
```

`frontend/src/lib/concept/layout.ts`:
```ts
const CANVAS_W = 3200;
const CANVAS_H = 2200;
```

- [ ] **Step 4: 백엔드 전체 스위트 통과 확인**

Run: `cd backend && uv run pytest -q`
Expected: `28 passed` (상수 심볼릭 참조라 그대로 초록).

- [ ] **Step 5: 실행 중 백엔드가 새 배치 영역을 반영하는지 관찰(런타임)**

빈 세션 `/retrieve`의 near 폴백은 `(CANVAS_W/2, CANVAS_H/2)`다. 새 값이면 `(1600, 1100)`.
```bash
# 신규 유저 토큰으로 빈 세션 retrieve → near 확인 (스크립트: scripts/... 또는 curl)
curl -s -X POST http://localhost:8000/retrieve -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"question":"reload probe","session_id":"00000000-0000-0000-0000-000000000000"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['near'])"
```
Expected: `{'x': 1600.0, 'y': 1100.0, 'score': None}` (구값이면 1300/800).

- [ ] **Step 6: 커밋**

```bash
git add backend/app/config.py backend/app/services/canvas_layout.py \
        frontend/src/components/canvas/NoteCanvas.tsx frontend/src/lib/concept/layout.ts
git commit -m "$(cat <<'EOF'
feat(layout): 주제 클러스터 분리 간격 확대(D_MAX 1500·CANVAS 3200x2200)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 리프 무겹침 배치 헬퍼 `leafPlacement.ts`

**Files:**
- Create: `frontend/src/lib/concept/leafPlacement.ts`
- Test: 프론트 유닛 러너 부재 → 임시 node 스크립트로 순수 함수 무겹침 검증(아래 Step 1) + `tsc`/`eslint`.

**Interfaces:**
- Consumes: `Concept`, `CanvasLeafNode`(`./types`).
- Produces:
  - `interface Rect { x:number; y:number; w:number; h:number }`
  - `const LEAF_DIMS: Record<CanvasLeafNode["type"], {w:number; h:number}>` = `{ video:{w:340,h:132}, art:{w:220,h:210} }`
  - `function cardRect(c: Concept): Rect`
  - `function leafRect(n: Pick<CanvasLeafNode,"x"|"y"|"type">): Rect`
  - `function placeLeafClear(px:number, py:number, w:number, h:number, obstacles: Rect[], gap?: number): {x:number; y:number}`

- [ ] **Step 1: 실패하는 순수-함수 검증 스크립트 작성(임시, 커밋 안 함)**

프론트 유닛 러너가 없으므로 node로 직접 검증한다. 조밀 장애물 격자에서 `placeLeafClear`가 반환한 자리가 **어떤 장애물과도 안 겹치는지** 단언. (아직 모듈이 없으니 import가 깨져 실패한다.)

`/tmp/leaf-unit.mjs`:
```js
import { placeLeafClear } from '/Users/dhkim/Desktop/ai-rookie/Nodi/frontend/src/lib/concept/leafPlacement.ts';
// (실행은 Step 4의 tsx/esbuild 경유; 여기선 로직 단언 정의)
const obstacles = [];
for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++)
  obstacles.push({ x: c*300, y: r*300, w: 420, h: 300 }); // 조밀 카드 격자
const hit = (a,b,g=24)=> a.x < b.x+b.w+g && a.x+a.w+g > b.x && a.y < b.y+b.h+g && a.y+a.h+g > b.y;
const p = placeLeafClear(300, 300, 340, 132, obstacles);
const bad = obstacles.filter(o => hit({x:p.x,y:p.y,w:340,h:132}, o)).length;
if (bad !== 0) { console.error('FAIL 겹침', bad, p); process.exit(1); }
console.log('PASS 무겹침', p);
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx tsx /tmp/leaf-unit.mjs`
Expected: FAIL — `Cannot find module '.../leafPlacement.ts'` (모듈 미존재).

- [ ] **Step 3: `leafPlacement.ts` 구현**

`frontend/src/lib/concept/leafPlacement.ts`:
```ts
// 리프 노드(영상/삽화) 무겹침 배치 — 개념 카드/다른 리프와 절대 겹치지 않게
// 선호 위치에서 나선으로 확장하며 가장 가까운 빈 자리를 찾는다(결정론).
// 서버 canvas_layout._first_free_position(AABB 나선 탐색) 이식. 캔버스는
// 무한 팬이므로 경계 클램프는 없다.

import type { CanvasLeafNode, Concept } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 리프 실측 근사 크기(px). VideoNode .node=340폭, ArtNode=220폭. 충돌 회피는
// 과대추정이 안전(여백↑) — 실제 렌더보다 약간 크게 잡아 시각적 겹침을 배제한다.
export const LEAF_DIMS: Record<CanvasLeafNode["type"], { w: number; h: number }> = {
  video: { w: 340, h: 132 },
  art: { w: 220, h: 210 },
};

// 개념 카드 폭/높이 — ConceptCard.cardHeight와 상수 일치(160/560/28).
const CARD_W = 420;
const CARD_H_MIN = 160;
const CARD_H_MAX = 560;
const CARD_H_PER_LINE = 28;
const CARD_H_STREAM_LINES = 2; // pending/스트리밍 기본(estimate_card_height(2))

// 카드 렌더 높이 근사: 서버 저장 concept.h 우선, 없으면 본문 "p" 블록 수(=줄 수)
// 기반 폴백. ConceptCard와 동일 로직 → 장애물 높이가 실제 렌더 높이와 일치.
function cardHeight(c: Concept): number {
  if (typeof c.h === "number" && c.h > 0) return c.h;
  const lines = c.pending
    ? CARD_H_STREAM_LINES
    : (c.blocks ?? []).filter((b) => b.type === "p").length;
  return Math.max(CARD_H_MIN, Math.min(CARD_H_MAX, CARD_H_MIN + lines * CARD_H_PER_LINE));
}

export function cardRect(c: Concept): Rect {
  return { x: c.x, y: c.y, w: CARD_W, h: cardHeight(c) };
}

export function leafRect(n: Pick<CanvasLeafNode, "x" | "y" | "type">): Rect {
  const d = LEAF_DIMS[n.type];
  return { x: n.x, y: n.y, w: d.w, h: d.h };
}

// 카드/리프 사이 최소 간격(px) — 서버 force_min_gap과 동일.
const LEAF_GAP = 24;

// gap 포함 AABB 교차 판정.
function hit(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

// 선호 위치 (px,py)에서 나선으로 확장하며 어떤 장애물과도 안 겹치는 가장 가까운
// 좌표를 반환(결정론). 못 찾으면 선호 위치 반환(사실상 도달 불가 — 80링 커버).
export function placeLeafClear(
  px: number,
  py: number,
  w: number,
  h: number,
  obstacles: Rect[],
  gap: number = LEAF_GAP,
): { x: number; y: number } {
  const free = (x: number, y: number) =>
    obstacles.every((o) => !hit({ x, y, w, h }, o, gap));
  if (free(px, py)) return { x: px, y: py };
  const step = 120; // 탐색 간격(px) — 좁은 틈도 포착
  for (let ring = 1; ring <= 80; ring++) {
    const r = ring * step;
    const samples = ring * 8; // 링마다 샘플 수↑ → 각 간격 일정 유지
    for (let k = 0; k < samples; k++) {
      const ang = (2 * Math.PI * k) / samples;
      const x = px + r * Math.cos(ang);
      const y = py + r * Math.sin(ang);
      if (free(x, y)) return { x, y };
    }
  }
  return { x: px, y: py };
}
```

- [ ] **Step 4: 검증 통과 + 타입/린트**

Run: `cd frontend && npx tsx /tmp/leaf-unit.mjs && npx tsc --noEmit && npx eslint src/lib/concept/leafPlacement.ts`
Expected: `PASS 무겹침 { x: …, y: … }`, tsc/eslint 무출력(EXIT 0).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/concept/leafPlacement.ts
git commit -m "$(cat <<'EOF'
feat(canvas): 리프 무겹침 배치 헬퍼(AABB 나선 탐색)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `useConceptStream`에 무겹침 배치 적용 (라이브 + 재수화) + E2E

**Files:**
- Modify: `frontend/src/lib/concept/useConceptStream.ts` (import; 라이브 스폰 블록; 재수화 리프 블록)
- Test: Playwright E2E(`leaf-overlap-probe.js`) — 라이브·재수화 양쪽 무겹침 관찰.

**Interfaces:**
- Consumes: Task 2의 `cardRect`, `leafRect`, `LEAF_DIMS`, `placeLeafClear`, `Rect`.
- Produces: 없음(내부 배치 로직만; `CanvasLeafNode` 필드 불변).

- [ ] **Step 1: import 추가**

`useConceptStream.ts` 상단 import 블록에 추가:
```ts
import {
  cardRect,
  leafRect,
  LEAF_DIMS,
  placeLeafClear,
  type Rect,
} from "./leafPlacement";
```

`LEAF_OFFSET_X` 주석을 "선호 위치"로 갱신(고정 오프셋 → 선호):
```ts
// 09: 리프(영상/삽화) 선호 오프셋 — 앵커 카드 오른쪽 옆(CARD_W + MARGIN)에서
// 순번마다 아래로 누적. 이 값은 "선호 위치"일 뿐, placeLeafClear가 카드/다른
// 리프와 겹치지 않는 가장 가까운 빈 자리로 확정한다(요구: 영상/삽화 ↔ 카드 무겹침).
const LEAF_OFFSET_X = LAYOUT.CARD_W + LAYOUT.MARGIN; // 460
```

- [ ] **Step 2: 라이브 스폰 블록 교체(고정 오프셋 → 나선 무겹침)**

기존 `for (const e of r.ebs) {…}` / `for (const a of r.art) {…}` (고정 `x: nearXY.x + LEAF_OFFSET_X, y: nearXY.y + leafOrder++ * LEAF_OFFSET_Y`)를 아래로 교체:
```ts
      const batch: CanvasLeafNode[] = [];
      let seq = leafNodesRef.current.length;
      let leafOrder = 0;
      // 충돌 회피: 기존 개념 카드(플레이스홀더 포함) + 기존 리프 + 이번 배치에서
      // 이미 놓은 리프를 장애물로 삼아, 리프가 어떤 카드와도 겹치지 않는 가장 가까운
      // 자리에 배치한다(선호 위치 = 앵커 오른쪽 스택).
      const obstacles: Rect[] = [
        ...conceptsRef.current.map(cardRect),
        ...leafNodesRef.current.map(leafRect),
      ];
      const spawnLeaf = (
        type: CanvasLeafNode["type"],
        extra: Partial<CanvasLeafNode>,
      ) => {
        const d = LEAF_DIMS[type];
        const prefX = nearXY.x + LEAF_OFFSET_X;
        const prefY = nearXY.y + leafOrder++ * LEAF_OFFSET_Y;
        const { x, y } = placeLeafClear(prefX, prefY, d.w, d.h, obstacles);
        obstacles.push({ x, y, w: d.w, h: d.h });
        const lid = "l" + ++seq;
        batch.push({ id: lid, type, x, y, conceptId: pid, ...extra });
      };
      for (const e of r.ebs) {
        spawnLeaf("video", {
          video: { videoId: e.videoId, title: e.title, thumb: e.thumb },
        });
      }
      for (const a of r.art) {
        spawnLeaf("art", { art: { slug: a.slug, url: a.url, title: a.title } });
      }
```

- [ ] **Step 3: 재수화 리프 블록 교체(고정 오프셋 → 나선 무겹침)**

기존 재수화 `const leaves: CanvasLeafNode[] = []; for (const n of reals) {…고정 오프셋…}`를 아래로 교체:
```ts
    // attachments.canvas → 리프 재생성. 좌표 전부 확정된 재수화 시점이므로 여기서
    // 무겹침을 확정한다: 앵커 오른쪽 스택을 선호 위치로, 모든 카드 + 앞서 놓은
    // 리프를 장애물로 삼아 placeLeafClear가 카드와 겹치지 않는 자리로 배치한다.
    const leaves: CanvasLeafNode[] = [];
    const obstacles: Rect[] = built.map(cardRect);
    for (const n of reals) {
      const canvas = (n as NodeRowWithAttachments).attachments?.canvas;
      if (!canvas) continue;
      const idx = firstIdxByNode.get(n.id);
      const anchor = idx == null ? undefined : built[idx];
      const baseXY = anchor ? { x: anchor.x, y: anchor.y } : { x: 40, y: 40 };
      let leafOrder = 0;
      const pushLeaf = (
        type: CanvasLeafNode["type"],
        extra: Partial<CanvasLeafNode>,
      ) => {
        const d = LEAF_DIMS[type];
        const prefX = baseXY.x + LEAF_OFFSET_X;
        const prefY = baseXY.y + leafOrder++ * LEAF_OFFSET_Y;
        const { x, y } = placeLeafClear(prefX, prefY, d.w, d.h, obstacles);
        obstacles.push({ x, y, w: d.w, h: d.h });
        const lid = "l" + (leaves.length + 1);
        leaves.push({ id: lid, type, x, y, conceptId: anchor?.id, ...extra });
      };
      for (const e of canvas.ebs ?? []) {
        if (!e?.video_id) continue;
        pushLeaf("video", {
          video: {
            videoId: String(e.video_id),
            title: e.title ?? "",
            thumb:
              e.thumb ?? `https://i.ytimg.com/vi/${e.video_id}/hqdefault.jpg`,
          },
        });
      }
      for (const a of canvas.art ?? []) {
        if (!a?.slug) continue;
        pushLeaf("art", {
          art: {
            slug: String(a.slug),
            url: a.url ?? `/art/${a.slug}.svg`,
            title: a.title ?? "",
          },
        });
      }
    }
```

- [ ] **Step 4: 타입/린트 통과**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/lib/concept/useConceptStream.ts`
Expected: 무출력(EXIT 0).

- [ ] **Step 5: Playwright E2E — 라이브+재수화 무겹침 관찰(런타임)**

프로브: 과학 질문 6개(영상/삽화 유도)로 조밀 군집 생성 → 카드·영상·삭화 노드를 **월드좌표(style.left/top) + offsetWidth/offsetHeight**(카메라 transform 무관)로 읽어 카드×카드/리프×카드/리프×리프 AABB 교차를 전수 검사. 리로드 후 드로어로 세션 재선택 → 재수화 배치도 검사.

Run: `node /tmp/nodi-e2e-QaXC/leaf-overlap-probe.js`
Expected:
```
[LIVE]  … leaf×card: 0쌍  card×card: 0쌍  leaf×leaf: 0쌍
[RELOAD]… leaf×card: 0쌍  card×card: 0쌍  leaf×leaf: 0쌍
=== 결과: LIVE 겹침 0쌍, RELOAD 겹침 0쌍 ===  ✓ 무겹침
```
(영상·삽화 노드가 실제로 ≥1개 스폰됐는지도 로그로 확인 — 리프 경로가 실제로 실행됐음을 보증.)

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/lib/concept/useConceptStream.ts
git commit -m "$(cat <<'EOF'
fix(canvas): 리프(영상/삽화)를 응답 카드와 무겹치게 배치(라이브+재수화)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 스펙 문서 반영 + 최종 확인

**Files:**
- Modify: `docs/superpowers/specs/2026-07-12-force-cluster-placement-design.md` (개정 노트·§2-5·§5·§8)

- [ ] **Step 1: 스펙 개정 반영 확인**

§1 개정 노트, §2-1 D_MAX 설명, §2-5(리프 무겹침), §5 파라미터표(D_MAX 1500·CANVAS 3200×2200), §6 leafPlacement, §8 테스트 6·7이 모두 기재됐는지 확인. (본 리비전에서 이미 작성됨.)

Run: `grep -nE "2-5|3200|1500|leafPlacement|무겹침" docs/superpowers/specs/2026-07-12-force-cluster-placement-design.md`
Expected: 해당 항목들이 출력됨.

- [ ] **Step 2: 전 구간 최종 확인**

Run: `cd backend && uv run pytest -q` → `28 passed`
Run: `cd frontend && npx tsc --noEmit` → EXIT 0

- [ ] **Step 3: 커밋**

```bash
git add docs/superpowers/specs/2026-07-12-force-cluster-placement-design.md
git commit -m "$(cat <<'EOF'
docs(spec): 리프 무겹침·주제 분리 간격 개정(2026-07-13)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- 스펙 §1 개정 "리프도 카드와 안 겹침" → Task 2(헬퍼)+Task 3(적용). ✓
- 스펙 §1 개정 "주제 분리 간격 확대(D_MAX↑·CANVAS↑)" → Task 1. ✓
- 스펙 §2-5(리프 무겹침 나선 배치, 라이브+재수화 양쪽) → Task 3 Step 2·3. ✓
- 스펙 §5(D_MAX 1500·CANVAS 3200×2200) → Task 1 Step 2·3. ✓
- 스펙 §8 테스트 6(리프 무겹침)·7(주제 분리) → Task 3 Step 5, Task 1 Step 5. ✓
- 갭 없음.

**2. Placeholder scan:** "TBD/TODO/적절히 처리" 없음. 모든 코드 스텝에 실제 코드 포함. ✓

**3. Type consistency:**
- `placeLeafClear(px,py,w,h,obstacles,gap?)` 시그니처가 Task 2 정의 ↔ Task 3 호출 일치. ✓
- `LEAF_DIMS[type]`, `cardRect(Concept)`, `leafRect(Pick<…>)`, `Rect{x,y,w,h}` 정의(Task 2) ↔ 사용(Task 3) 일치. ✓
- `CanvasLeafNode["type"]` = `"video"|"art"`(types.ts) — `LEAF_DIMS` 키와 일치. ✓

---

## 구현 현황(참고)

본 계획의 Task 1~4는 **이미 구현·검증 완료**된 상태를 그대로 기술한다(리비전 작업 중 선구현). Playwright E2E 실측: 라이브·재수화 양쪽 **겹침 0쌍**(영상 2·삽화 1 스폰), 카드 중심 최대거리 1644px(구 D_MAX 1200 초과). 백엔드 `28 passed`, 프론트 `tsc`/`eslint` EXIT 0. 계획을 재실행하려면 subagent-driven-development로, 아니면 이 문서를 리뷰 기준으로 사용한다.
