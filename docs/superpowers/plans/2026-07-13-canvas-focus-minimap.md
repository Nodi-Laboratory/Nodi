# 캔버스 생성-포커싱 · 맵 앵커 로딩 · D3 위치 미니맵 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 새 개념 생성 시 그 지점으로 카메라를 팬하고, 로딩 애니메이션을 그 지점 위(맵 내부)에 앵커하며, 개념트리를 클러스터=점의 D3 위치 미니맵으로 렌더하고 점 클릭 시 해당 클러스터로 이동한다.

**Architecture:** `useConceptStream`이 답변당 첫 개념의 생성 좌표를 담은 `focusSignal{x,y,key}` 하나를 노출한다. 이 신호가 (1) 워크스페이스의 카메라 팬 effect와 (2) 맵 내부 로딩 버블의 위치를 동시에 구동한다. 개념트리는 순수 헬퍼(`minimapLayout.ts`)로 클러스터의 공간 centroid·픽셀 매핑·뷰포트 사각형을 계산하고, `ConceptMinimap.tsx`가 `d3.scaleLinear`로 좌표를 매핑해 React SVG로 렌더한다.

**Tech Stack:** Next.js 16 / React 19 / TypeScript, d3-scale(이미 의존성), 기존 `focusCamera`/`grouping.ts`. 서버/DB 변경 없음. 프론트 유닛 러너 부재 → 순수 헬퍼는 `npx tsx` node 새너티, UI는 `tsc`/`eslint` + Playwright E2E.

## Global Constraints

- **단일 신호원**: `focusSignal{x,y,key}` 하나가 카메라 포커스 + 로딩 버블 위치를 동시 구동. 중복 상태 금지.
- **재수화 시 `focusSignal` 미설정**: 라이브 `send`에서만 설정. 세션 로드 초기 포커스는 기존 `concepts[0]` 1회 로직 유지.
- **`Date.now()`/`Math.random()` 금지**: `focusSignal.key`는 `useRef` 정수 카운터 `++`(결정론·테스트).
- **D3는 계산, React는 DOM**: `d3.scaleLinear`로 좌표만 매핑, SVG는 React가 렌더(`d3.select` DOM 변형 금지 — React 19 충돌 방지).
- **클러스터 = 기존 `grouping.ts` 그룹 재사용**. 그룹 1개 = 미니맵 점 1개. 점 위치 = 그룹 멤버 카드 **중심**의 월드 평균(spatial centroid). 좌표 없는 멤버는 제외.
- **미니맵 위 `data-no-pan`**: 미니맵 포인터가 캔버스 팬을 트리거하지 않게.
- **좌표 상수**: `CARD_CX=210`, `CARD_CY=200`(기존 workspace), `CARD_W=420`. 미니맵 `W=260,H=180,pad=16`.
- **`git add`는 명시 경로만** (레포에 커밋 전 미추적 파일 다수 — `git add -A` 금지).
- **커밋 트레일러**: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **(프로세스) 서브에이전트는 opus 4.8 사용.**

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `frontend/src/lib/concept/useConceptStream.ts` | 스트리밍 상태 | `focusSignal` state 추가·노출, `send`에서 set |
| `frontend/src/components/canvas/ConceptCanvasWorkspace.tsx` | 캔버스 오케스트레이션 | 포커스 effect, 로딩 버블 렌더, 중앙 칩 제거, 미니맵 배선 |
| `frontend/src/components/canvas/MapLoadingIndicator.tsx` | **신설** — 맵 내부 앵커 로딩 버블 | Create |
| `frontend/src/lib/concept/minimapLayout.ts` | **신설** — 순수 레이아웃(centroid·fit·viewport) | Create |
| `frontend/src/components/canvas/ConceptMinimap.tsx` | **신설** — D3 스케일 + React SVG 미니맵 | Create |
| `frontend/src/components/canvas/ConceptTreePanel.tsx`(+`.module.css`) | 트리 패널 | 본문을 미니맵으로 교체, props 확장 |

**검증 도구:** 프론트 유닛 러너(jest/vitest) **없음**. 순수 헬퍼는 `npx tsx <script>` node 새너티, UI는 `npx tsc --noEmit`+`npx eslint`+Playwright E2E(`/tmp/nodi-e2e-QaXC/` 하네스 재사용). 실행 중 dev 서버(3000/8000) 사용.

---

## Task 1: 생성 지점 자동 포커싱 (`focusSignal` + 카메라 팬)

**Files:**
- Modify: `frontend/src/lib/concept/useConceptStream.ts` (interface·state·send)
- Modify: `frontend/src/components/canvas/ConceptCanvasWorkspace.tsx` (focus effect)

**Interfaces:**
- Produces: `ConceptStream.focusSignal: { x: number; y: number; key: number } | null` — 답변당 첫 개념 생성 좌표(top-left). `key`는 매 send 증가.

- [ ] **Step 1: `ConceptStream` 인터페이스에 `focusSignal` 추가**

`useConceptStream.ts` 인터페이스(현재 176-184행):
```ts
export interface ConceptStream {
  concepts: Concept[];
  groups: ConceptGroup[];
  leafNodes: CanvasLeafNode[];
  reply: string;
  busy: boolean;
  loading: boolean;
  /** 답변당 첫 개념 생성 좌표(top-left). key는 send마다 증가 — 같은 좌표라도 effect 재발화. */
  focusSignal: { x: number; y: number; key: number } | null;
  send: (question: string) => Promise<void>;
}
```

- [ ] **Step 2: state + key 카운터 추가**

`useConceptStream.ts` state 블록(현재 196행 `const [loading...` 아래)에:
```ts
  const [focusSignal, setFocusSignal] = useState<
    { x: number; y: number; key: number } | null
  >(null);
```
ref 블록(현재 209행 `baseConceptIdxRef` 아래)에:
```ts
  // 자동 포커싱 트리거 카운터(Date.now 금지 — 결정론). send마다 ++.
  const focusKeyRef = useRef(0);
```

- [ ] **Step 3: `send`에서 플레이스홀더 커밋 직후 신호 설정**

`send`의 플레이스홀더 `commitConcepts([...])` 블록(현재 388-404행, `pending: true` 로 끝나는 배열) **바로 다음 줄**에 추가:
```ts
      // 자동 포커싱: 이번 답변 첫 개념(플레이스홀더) 생성 지점으로 카메라를 옮기게 신호.
      setFocusSignal({ x: nearXY.x, y: nearXY.y, key: ++focusKeyRef.current });
```

- [ ] **Step 4: 반환 객체에 `focusSignal` 추가**

`useConceptStream.ts` 반환문(현재 `return { concepts, groups, leafNodes, reply, busy, loading, send };`)을:
```ts
  return { concepts, groups, leafNodes, reply, busy, loading, focusSignal, send };
```

- [ ] **Step 5: 워크스페이스에서 신호를 구독해 카메라 팬**

`ConceptCanvasWorkspace.tsx` 훅 구조분해(현재 37-38행)를:
```tsx
  const { concepts, groups, leafNodes, reply, busy, loading, focusSignal, send } =
    useConceptStream(target);
```
초기 포커스 effect(현재 `didInitFocus`를 쓰는 "Focus the first card once it exists" effect) **다음에** 추가:
```tsx
  // 생성 지점 자동 포커싱: 새 답변의 첫 개념 좌표로 부드럽게 1회 팬(NoteCanvas 0.7s 트랜지션).
  // focusSignal.key가 매 send 증가 → 같은 좌표라도 재발화. 재수화는 focusSignal=null이라 무동작.
  useEffect(() => {
    if (!focusSignal) return;
    setCamera(
      focusCamera(vp(), { x: focusSignal.x + CARD_CX, y: focusSignal.y + CARD_CY }, 1),
    );
  }, [focusSignal, vp]);
```

- [ ] **Step 6: 타입/린트 통과**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/lib/concept/useConceptStream.ts src/components/canvas/ConceptCanvasWorkspace.tsx`
Expected: EXIT 0(무출력).

- [ ] **Step 7: Playwright — 자동 포커싱 관찰(런타임)**

프로브 핵심(신규 유저 세션에서 질문 1회 후 카메라 확인). `note-canvas`의 transform에서 `translate(x,y) scale(s)` 파싱 → 첫 개념 카드(`data-testid="concept-card"`)의 style.left/top(월드)을 화면 좌표로 변환해 뷰포트 중심 근처인지 확인:
```js
const cam = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="note-canvas"]');
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(el.style.transform);
  return { x: +m[1], y: +m[2], s: +m[3] };
});
const card = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="concept-card"]');
  return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
});
const screenX = cam.x + (card.x + 210) * cam.s;   // 뷰포트 폭 1440 기준 중심 ~720±300
const screenY = cam.y + (card.y + 200) * cam.s;    // 뷰포트 높이 900 기준 중심 ~450±300
console.log('첫 개념 화면좌표', Math.round(screenX), Math.round(screenY));
```
Expected: `screenX ≈ 720±350`, `screenY ≈ 450±350`(첫 개념이 화면 중앙 부근). 포커싱 없으면 화면 밖(±1000+) 가능.

- [ ] **Step 8: 커밋**

```bash
git add frontend/src/lib/concept/useConceptStream.ts frontend/src/components/canvas/ConceptCanvasWorkspace.tsx
git commit -m "$(cat <<'EOF'
[feat]: 생성 지점 자동 포커싱 — 답변당 첫 개념 좌표로 카메라 1회 팬(focusSignal)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 맵 앵커 로딩 (`MapLoadingIndicator` + 중앙 칩 제거)

**Files:**
- Create: `frontend/src/components/canvas/MapLoadingIndicator.tsx`
- Modify: `frontend/src/components/canvas/ConceptCanvasWorkspace.tsx` (NoteCanvas 내부 렌더, `LoadingChip` 제거)

**Interfaces:**
- Consumes: Task 1의 `focusSignal`, 기존 `loading`.
- Produces: `MapLoadingIndicator({ x, y, visible })` — 맵 좌표 (x,y)의 카드 위에 앵커되는 로딩 버블.

- [ ] **Step 1: `MapLoadingIndicator` 구현**

`frontend/src/components/canvas/MapLoadingIndicator.tsx`:
```tsx
"use client";

// 맵 내부 앵커 로딩 버블 — NoteCanvas children으로 렌더돼 맵 transform(팬/줌)을 따라간다.
// 생성 지점(x,y=카드 top-left) 위에 마스코트 + 점 3개 바운스로 "노트를 쓰는 중"을 표시.
// 화면 중앙 고정 칩(LoadingChip)을 대체한다. pending 스켈레톤 카드는 별도 유지.

const BUBBLE_W = 168;
const CARD_CX = 210; // 카드 폭 절반(중앙 정렬용) — workspace 상수와 일치

export default function MapLoadingIndicator({
  x,
  y,
  visible,
}: {
  x: number;
  y: number;
  visible: boolean;
}) {
  if (!visible) return null;
  return (
    <div
      className="nodi-spawn"
      data-testid="map-loading"
      style={{
        position: "absolute",
        left: x + CARD_CX - BUBBLE_W / 2,
        top: y - 56,
        width: BUBBLE_W,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        background: "var(--bg)",
        border: "1px solid rgba(43,38,32,.12)",
        borderRadius: 999,
        boxShadow: "0 6px 22px rgba(43,38,32,.14)",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/nodi-mascot.png"
        alt=""
        style={{ height: 26, width: "auto", mixBlendMode: "multiply" }}
      />
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        <i className="nodi-ldot" style={{ animationDelay: "0ms" }} />
        <i className="nodi-ldot" style={{ animationDelay: "140ms" }} />
        <i className="nodi-ldot" style={{ animationDelay: "280ms" }} />
      </span>
      <span
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 13,
          color: "var(--ink)",
          whiteSpace: "nowrap",
        }}
      >
        노트를 쓰는 중…
      </span>
    </div>
  );
}
```

- [ ] **Step 2: 워크스페이스에서 NoteCanvas 내부에 렌더 + 중앙 칩 제거**

`ConceptCanvasWorkspace.tsx` import에 추가:
```tsx
import MapLoadingIndicator from "./MapLoadingIndicator";
```
NoteCanvas children(현재 `{leafNodes.map(...)}` 다음)에 추가:
```tsx
        {/* 맵 앵커 로딩 — 생성 지점 위 버블(맵과 함께 팬/줌). */}
        {focusSignal && (
          <MapLoadingIndicator
            x={focusSignal.x}
            y={focusSignal.y}
            visible={loading}
          />
        )}
```
그리고 화면 중앙 칩 제거 — 현재 `{loading && <LoadingChip />}` 줄과 파일 하단의 `function LoadingChip() { ... }` 정의를 **삭제**한다.

- [ ] **Step 3: 타입/린트 통과**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/components/canvas/MapLoadingIndicator.tsx src/components/canvas/ConceptCanvasWorkspace.tsx`
Expected: EXIT 0. (`LoadingChip` 미사용 잔재 없어야 함 — 정의까지 삭제.)

- [ ] **Step 4: Playwright — 맵 앵커 로딩 관찰(런타임)**

질문 직후(스트리밍 중) 상태 확인:
```js
await input.fill('광합성이 뭐야?'); await input.press('Enter');
await page.waitForTimeout(1200);   // 스트리밍 초기
const hasMapLoading = await page.locator('[data-testid="map-loading"]').count();
const hasCenterChip = await page.locator('[data-testid="loading"]').count(); // 옛 중앙 칩
console.log('map-loading', hasMapLoading, '중앙칩', hasCenterChip);
await page.waitForTimeout(16000);  // done
const afterDone = await page.locator('[data-testid="map-loading"]').count();
console.log('done 후 map-loading', afterDone);
```
Expected: 로딩 중 `map-loading ≥ 1`, `중앙칩 0`; done 후 `map-loading 0`.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/components/canvas/MapLoadingIndicator.tsx frontend/src/components/canvas/ConceptCanvasWorkspace.tsx
git commit -m "$(cat <<'EOF'
[feat]: 맵 앵커 로딩 — 생성 지점 위 마스코트 버블(중앙 고정 칩 제거)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 미니맵 순수 레이아웃 헬퍼 `minimapLayout.ts`

**Files:**
- Create: `frontend/src/lib/concept/minimapLayout.ts`
- Test: node 새너티(`npx tsx /tmp/minimap-unit.ts`) + `tsc`/`eslint`.

**Interfaces:**
- Consumes: `Concept`, `ConceptGroup`(`./types`).
- Produces:
  - `interface MiniCentroid { id; label; count; repConceptId; wx; wy }`
  - `interface BBox { minX; minY; maxX; maxY }`, `interface Fit { s; ox; oy }`
  - `groupCentroids(groups, concepts): MiniCentroid[]`
  - `worldBBox(pts: {wx;wy}[]): BBox | null`
  - `fitTransform(bbox: BBox, width, height, pad): Fit`
  - `project(wx, wy, fit): { cx; cy }`
  - `viewportRectPx(camera:{x;y;scale}, vp:{w;h}, fit): { x; y; w; h }`

- [ ] **Step 1: 실패하는 node 새너티 작성**

`/tmp/minimap-unit.ts`:
```ts
import {
  groupCentroids, worldBBox, fitTransform, project, viewportRectPx,
} from "/Users/dhkim/Desktop/ai-rookie/Nodi/frontend/src/lib/concept/minimapLayout.ts";

const concepts = [
  { id: "c1", x: 1000, y: 800, h: 200 },
  { id: "c2", x: 1040, y: 820, h: 200 },
  { id: "c3", x: 2000, y: 1200, h: 300 },
] as any;
const groups = [
  { id: "g1", label: "A", memberIds: ["c1", "c2"], centroid: [], repConceptId: "c1" },
  { id: "g2", label: "B", memberIds: ["c3"], centroid: [], repConceptId: "c3" },
] as any;

const cs = groupCentroids(groups, concepts);
// g1 centroid = ((1000+210 + 1040+210)/2, (800+100 + 820+100)/2) = (1230, 910)
if (Math.round(cs[0].wx) !== 1230 || Math.round(cs[0].wy) !== 910) throw new Error("centroid g1 " + JSON.stringify(cs[0]));
if (cs[0].count !== 2 || cs[1].count !== 1) throw new Error("count");

const bbox = worldBBox(cs.map((c) => ({ wx: c.wx, wy: c.wy })))!;
const fit = fitTransform(bbox, 260, 180, 16);
// 모든 점이 미니맵 [pad, size-pad] 안
for (const c of cs) {
  const { cx, cy } = project(c.wx, c.wy, fit);
  if (cx < 15 || cx > 245 || cy < 15 || cy > 165) throw new Error("project out " + cx + "," + cy);
}
// 동일 배율(종횡비 보존): x/y 배율이 같아야 함 → project 선형성 확인
const vr = viewportRectPx({ x: 0, y: 0, scale: 1 }, { w: 1440, h: 900 }, fit);
if (!(vr.w > 0 && vr.h > 0)) throw new Error("viewport");
console.log("PASS", cs.length, "clusters", { fit, vr });
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx tsx /tmp/minimap-unit.ts`
Expected: FAIL — `Cannot find module '.../minimapLayout.ts'`.

- [ ] **Step 3: `minimapLayout.ts` 구현**

`frontend/src/lib/concept/minimapLayout.ts`:
```ts
// 미니맵 순수 레이아웃 — 클러스터 공간 centroid, 월드→미니맵 픽셀 매핑(종횡비 보존),
// 카메라 가시영역→미니맵 사각형. DOM/React 독립(테스트·재사용). d3 미의존(순수 산술);
// d3.scaleLinear 사용은 렌더 컴포넌트(ConceptMinimap)에서 이 Fit로 구성한다.

import type { Concept, ConceptGroup } from "./types";

const CARD_CX = 210; // 카드 폭 420의 절반
const CARD_H_FALLBACK = 200; // 높이 미상 시 근사(중심 계산용)

export interface MiniCentroid {
  id: string;
  label: string;
  count: number;
  repConceptId: string;
  wx: number;
  wy: number;
}
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface Fit {
  s: number;
  ox: number;
  oy: number;
}

// 그룹별 멤버 카드 "중심"의 월드 평균. 좌표 없는 멤버 제외, 유효 멤버 0이면 그룹 스킵.
export function groupCentroids(
  groups: ConceptGroup[],
  concepts: Concept[],
): MiniCentroid[] {
  const byId = new Map<string, Concept>();
  for (const c of concepts) byId.set(c.id, c);
  const out: MiniCentroid[] = [];
  for (const g of groups) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const mid of g.memberIds) {
      const c = byId.get(mid);
      if (!c || typeof c.x !== "number" || typeof c.y !== "number") continue;
      const h = typeof c.h === "number" && c.h > 0 ? c.h : CARD_H_FALLBACK;
      sx += c.x + CARD_CX;
      sy += c.y + h / 2;
      n += 1;
    }
    if (n === 0) continue;
    out.push({
      id: g.id,
      label: g.label,
      count: g.memberIds.length,
      repConceptId: g.repConceptId,
      wx: sx / n,
      wy: sy / n,
    });
  }
  return out;
}

export function worldBBox(pts: Array<{ wx: number; wy: number }>): BBox | null {
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.wx < minX) minX = p.wx;
    if (p.wx > maxX) maxX = p.wx;
    if (p.wy < minY) minY = p.wy;
    if (p.wy > maxY) maxY = p.wy;
  }
  return { minX, minY, maxX, maxY };
}

// bbox를 (width×height) 안에 pad 여백으로, 단일 배율 s=min(sx,sy)로 종횡비 보존 매핑.
// cx = ox + wx*s, cy = oy + wy*s. 폭 0(단일/동일 좌표)이면 s를 상한으로 클램프.
export function fitTransform(bbox: BBox, width: number, height: number, pad: number): Fit {
  const bw = bbox.maxX - bbox.minX;
  const bh = bbox.maxY - bbox.minY;
  const availW = width - 2 * pad;
  const availH = height - 2 * pad;
  const sX = bw > 0 ? availW / bw : Infinity;
  const sY = bh > 0 ? availH / bh : Infinity;
  let s = Math.min(sX, sY);
  if (!Number.isFinite(s)) s = 1; // 점 1개(또는 모두 동일 좌표) → 배율 1, 중앙 배치
  // 사용 영역을 중앙 정렬: ox = pad + (availW - bw*s)/2 - minX*s
  const ox = pad + (availW - bw * s) / 2 - bbox.minX * s;
  const oy = pad + (availH - bh * s) / 2 - bbox.minY * s;
  return { s, ox, oy };
}

export function project(wx: number, wy: number, fit: Fit): { cx: number; cy: number } {
  return { cx: fit.ox + wx * fit.s, cy: fit.oy + wy * fit.s };
}

// 카메라 가시 월드 사각형 → 미니맵 픽셀 사각형.
// 가시 월드 top-left = (-cam.x/scale, -cam.y/scale), size = (vp.w/scale, vp.h/scale).
export function viewportRectPx(
  camera: { x: number; y: number; scale: number },
  vp: { w: number; h: number },
  fit: Fit,
): { x: number; y: number; w: number; h: number } {
  const s = camera.scale || 1;
  const wx0 = -camera.x / s;
  const wy0 = -camera.y / s;
  const { cx, cy } = project(wx0, wy0, fit);
  return { x: cx, y: cy, w: (vp.w / s) * fit.s, h: (vp.h / s) * fit.s };
}
```

- [ ] **Step 4: 새너티 통과 + 타입/린트**

Run: `cd frontend && npx tsx /tmp/minimap-unit.ts && npx tsc --noEmit && npx eslint src/lib/concept/minimapLayout.ts`
Expected: `PASS 2 clusters {...}`, tsc/eslint EXIT 0.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/concept/minimapLayout.ts
git commit -m "$(cat <<'EOF'
[feat]: 미니맵 순수 레이아웃 헬퍼 — 클러스터 centroid·종횡비 매핑·뷰포트 사각형

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: D3 미니맵 렌더 + 트리 패널 통합 + 클릭 내비

**Files:**
- Create: `frontend/src/components/canvas/ConceptMinimap.tsx`
- Modify: `frontend/src/components/canvas/ConceptTreePanel.tsx`(+`.module.css`)
- Modify: `frontend/src/components/canvas/ConceptCanvasWorkspace.tsx` (camera/vp/onFocus 배선)

**Interfaces:**
- Consumes: Task 3의 `groupCentroids/worldBBox/fitTransform/project/viewportRectPx`, `d3-scale`의 `scaleLinear`, 기존 `Camera`/`focusCamera`.
- Produces: `ConceptMinimap({ groups, concepts, camera, viewport, activeId, onFocus })`; `ConceptTreePanel`의 `onFocus` 시그니처를 `(target: { x: number; y: number }) => void`로 변경.

- [ ] **Step 1: `ConceptMinimap` 구현**

`frontend/src/components/canvas/ConceptMinimap.tsx`:
```tsx
"use client";

// D3 위치 미니맵 — 클러스터를 실제 맵 위치의 축소 점으로 렌더. d3.scaleLinear로 좌표를
// 매핑(계산), SVG는 React가 렌더(React 19 안전). 점 클릭 → onFocus(클러스터 월드 중심).

import { useMemo } from "react";
import { scaleLinear } from "d3-scale";
import type { Concept, ConceptGroup } from "@/lib/concept/types";
import {
  groupCentroids,
  worldBBox,
  fitTransform,
  viewportRectPx,
} from "@/lib/concept/minimapLayout";

const W = 260;
const H = 180;
const PAD = 16;

export default function ConceptMinimap({
  groups,
  concepts,
  camera,
  viewport,
  activeId,
  onFocus,
}: {
  groups: ConceptGroup[];
  concepts: Concept[];
  camera: { x: number; y: number; scale: number };
  viewport: { w: number; h: number };
  activeId: string | null;
  onFocus: (target: { x: number; y: number }) => void;
}) {
  const nodes = useMemo(() => groupCentroids(groups, concepts), [groups, concepts]);
  const bbox = useMemo(
    () => worldBBox(nodes.map((n) => ({ wx: n.wx, wy: n.wy }))),
    [nodes],
  );

  if (!bbox) {
    return <p style={{ margin: 12, fontSize: 13, opacity: 0.6 }}>질문하면 개념이 여기 모여요.</p>;
  }

  const fit = fitTransform(bbox, W, H, PAD);
  // d3.scaleLinear로 월드→픽셀 매핑(동일 배율 s를 양축에 적용 → 종횡비 보존).
  const sx = scaleLinear().domain([bbox.minX, bbox.maxX]).range([fit.ox + bbox.minX * fit.s, fit.ox + bbox.maxX * fit.s]);
  const sy = scaleLinear().domain([bbox.minY, bbox.maxY]).range([fit.oy + bbox.minY * fit.s, fit.oy + bbox.maxY * fit.s]);
  const vr = viewportRectPx(camera, viewport, fit);

  return (
    <svg width={W} height={H} data-testid="concept-minimap" data-no-pan style={{ display: "block" }}>
      <rect x={0} y={0} width={W} height={H} rx={10} fill="rgba(43,38,32,.04)" />
      {/* 현재 카메라 가시영역 */}
      <rect
        x={vr.x}
        y={vr.y}
        width={vr.w}
        height={vr.h}
        fill="none"
        stroke="rgba(43,38,32,.35)"
        strokeWidth={1}
        rx={3}
      />
      {nodes.map((n) => {
        const cx = sx(n.wx);
        const cy = sy(n.wy);
        const r = Math.max(6, Math.min(22, 6 + Math.sqrt(n.count) * 3));
        const active = n.repConceptId === activeId;
        return (
          <g
            key={n.id}
            transform={`translate(${cx},${cy})`}
            style={{ cursor: "pointer" }}
            onClick={() => onFocus({ x: n.wx, y: n.wy })}
          >
            <circle
              r={r}
              fill={active ? "var(--hl-yellow, #FFC526)" : "rgba(43,38,32,.55)"}
              stroke="#fff"
              strokeWidth={1.5}
            />
            <text
              x={0}
              y={r + 11}
              textAnchor="middle"
              fontSize={10}
              fill="var(--ink, #2b2620)"
              style={{ pointerEvents: "none" }}
            >
              {n.label.length > 8 ? n.label.slice(0, 8) + "…" : n.label}
            </text>
            {n.count > 1 && (
              <text x={0} y={3} textAnchor="middle" fontSize={9} fill="#fff" style={{ pointerEvents: "none" }}>
                {n.count}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 2: `ConceptTreePanel` 본문을 미니맵으로 교체 + props 확장**

`ConceptTreePanel.tsx`를 아래로 교체(토글/헤더 유지, 본문만 미니맵):
```tsx
"use client";

// 개념트리 — 개념 카드를 클러스터=점으로 보여주는 D3 위치 미니맵 패널.
// 점 클릭 시 본 캔버스가 그 클러스터 위치로 팬(onFocus).

import type { Camera } from "./NoteCanvas";
import type { Concept, ConceptGroup } from "@/lib/concept/types";
import ConceptMinimap from "./ConceptMinimap";
import styles from "./ConceptTreePanel.module.css";

export default function ConceptTreePanel({
  open,
  onToggle,
  groups,
  concepts,
  activeId,
  camera,
  viewport,
  onFocus,
}: {
  open: boolean;
  onToggle: () => void;
  groups: ConceptGroup[];
  concepts: Concept[];
  activeId: string | null;
  camera: Camera;
  viewport: { w: number; h: number };
  onFocus: (target: { x: number; y: number }) => void;
}) {
  if (!open) {
    return (
      <button
        type="button"
        className={styles.edge}
        onClick={onToggle}
        data-no-pan
        aria-label="개념 트리 펼치기"
      >
        <span className={styles.dot} />
        개념 {concepts.length}
      </button>
    );
  }

  return (
    <aside className={styles.panel} data-testid="concept-tree" data-no-pan>
      <div className={styles.header}>
        <span>개념 트리</span>
        <span className={styles.count}>{groups.length}개 개념</span>
        <button
          type="button"
          className={styles.collapse}
          onClick={onToggle}
          aria-label="개념 트리 접기"
        >
          ✕
        </button>
      </div>
      <div className={styles.body}>
        <ConceptMinimap
          groups={groups}
          concepts={concepts}
          camera={camera}
          viewport={viewport}
          activeId={activeId}
          onFocus={onFocus}
        />
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: 워크스페이스 배선 — camera/viewport 주입, onFocus 좌표화**

`ConceptCanvasWorkspace.tsx`의 `ConceptTreePanel` 사용부(현재 173-180행)를:
```tsx
      <ConceptTreePanel
        open={treeOpen}
        onToggle={() => setTreeOpen((v) => !v)}
        groups={groups}
        concepts={concepts.filter((c) => !c.pending)}
        activeId={activeId}
        camera={camera}
        viewport={vp()}
        onFocus={(target) =>
          setCamera(focusCamera(vp(), { x: target.x, y: target.y }, 1))
        }
      />
```
(클러스터 centroid는 이미 카드 중심 월드좌표라 CARD_CX/CY 보정 없이 `focusCamera`에 그대로 전달.)

- [ ] **Step 4: 타입/린트 통과**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/components/canvas/ConceptMinimap.tsx src/components/canvas/ConceptTreePanel.tsx src/components/canvas/ConceptCanvasWorkspace.tsx`
Expected: EXIT 0.

- [ ] **Step 5: Playwright — 미니맵 렌더 + 클릭 내비 관찰(런타임)**

다주제 질문 3~4개 후:
```js
// 미니맵 열기(edge 버튼) 후 점 수 = 그룹 수, 배지 합 = 카드 수 확인
await page.getByLabel('개념 트리 펼치기').click();
const dots = await page.locator('[data-testid="concept-minimap"] circle').count(); // 뷰포트 rect 1개 제외
const groups = await page.locator('[data-testid="concept-minimap"] g').count();
console.log('클러스터 g', groups);
// 점 클릭 → 카메라 변화 확인
const before = await page.evaluate(() => document.querySelector('[data-testid="note-canvas"]').style.transform);
await page.locator('[data-testid="concept-minimap"] g').first().click();
await page.waitForTimeout(1000);
const after = await page.evaluate(() => document.querySelector('[data-testid="note-canvas"]').style.transform);
console.log('팬 변화', before !== after);
```
Expected: `클러스터 g` = 그룹 수(≥2), `팬 변화 true`(클릭 후 카메라 이동).

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/components/canvas/ConceptMinimap.tsx frontend/src/components/canvas/ConceptTreePanel.tsx frontend/src/components/canvas/ConceptCanvasWorkspace.tsx
git commit -m "$(cat <<'EOF'
[feat]: D3 위치 미니맵 개념트리 — 클러스터=점, 뷰포트 사각형, 점 클릭→클러스터로 팬

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- §3 자동 포커싱(focusSignal, key 카운터, 카메라 팬, 재수화 미설정) → Task 1. ✓
- §4 맵 앵커 로딩(MapLoadingIndicator 맵 내부 렌더, 중앙 칩 제거, pending 유지) → Task 2. ✓
- §5-2 순수 레이아웃(groupCentroids·fitTransform·viewportRect) → Task 3. ✓
- §5-3 D3 렌더(d3.scaleLinear, 점 크기 √count, 뷰포트 사각형, data-no-pan) → Task 4 Step 1. ✓
- §5-4 패널 통합(토글/헤더 유지, 본문 교체, onFocus 좌표화) → Task 4 Step 2·3. ✓
- §5-3 클릭 내비(centroid로 팬) → Task 4 Step 1(onClick)·Step 3(setCamera). ✓
- §9-1 순수 유닛 → Task 3 Step 1. §9-2 E2E 5종 → Task 1 Step 7, Task 2 Step 4, Task 4 Step 5. ✓
- 갭 없음. (서버/DB 변경 없음 — §10 준수.)

**2. Placeholder scan:** "TBD/TODO/적절히" 없음. 모든 코드 스텝에 실제 코드. ✓

**3. Type consistency:**
- `focusSignal: {x,y,key}|null` — Task 1 정의 ↔ Task 2 사용 일치. ✓
- `groupCentroids/worldBBox/fitTransform/project/viewportRectPx` 시그니처 — Task 3 정의 ↔ Task 4 import 일치. ✓
- `ConceptTreePanel.onFocus: (target:{x,y})=>void` — Task 4 Step 2 정의 ↔ Step 3 전달 일치(기존 `(conceptId)=>`에서 변경). ✓
- `ConceptMinimap` props(groups/concepts/camera/viewport/activeId/onFocus) — Step 1 정의 ↔ Step 2 전달 일치. ✓
- `Camera`(NoteCanvas export) — TreePanel/Minimap에서 `{x,y,scale}` 구조로 사용, 일치. ✓
