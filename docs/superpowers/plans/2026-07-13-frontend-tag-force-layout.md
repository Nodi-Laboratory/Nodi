# 프론트 d3-force 태그 클러스터 레이아웃 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카드 위치를 서버 `place` 좌표 대신 프론트 d3-force 시뮬레이션(태그=클러스터, 노드 수↑→분리↑)으로 계산하고, 태그를 지도에 마커로 표시하며, 개념트리(미니맵)를 태그 무게중심으로 렌더한다.

**Architecture:** `tagLayoutCore.ts`(순수: 시드·무게중심·반경) + `useTagLayout.ts`(d3-force 훅, positions+tagCentroids) → `ConceptCanvasWorkspace`가 sim 좌표를 카드에 오버레이하고 `TagMarker`·`ConceptMinimap`에 무게중심을 공급. 서버 좌표는 무시(프론트 권위). 위치 비영속·결정론 시드.

**Tech Stack:** Next.js 16/React 19/TS, `d3-force`+`d3-scale`(이미 의존성 `d3` ^7.9.0). 프론트 유닛 러너 없음 → 순수 헬퍼는 `npx tsx` node 새너티, UI/시뮬은 tsc/eslint + Playwright.

## Global Constraints

- **프론트가 카드 위치 권위**: 카드는 `useTagLayout` positions로 렌더. 서버 `place` 좌표·`concept.x/y`는 렌더에 쓰지 않는다(개념 생성 신호로만).
- **태그 = 클러스터**: 카드=force 노드, 자기 태그 무게중심으로 응집 + `forceManyBody`(count↑ 태그가 더 밀어냄) + `forceCollide`(무겹침). 빈 태그 → `"기타"`.
- **결정론 시드**: 각 카드 초기 위치 = `tagSeed(tagIndex, cardIndex)`(태그 첫등장 순서 황금각). d3 난수 초기화 회피(x/y 항상 시드). 재수화 레이아웃 안정.
- **위치 비영속**: attachments의 x/y는 무시(태그만 사용). 재수화는 태그+개수로 재시뮬레이션.
- **캔버스 무한 팬**: 경계 클램프 없음(클러스터가 필요한 만큼 퍼짐).
- **CARD_W=420**, 카드 충돌 반경 ≈ `hypot(CARD_W, h)/2 + gap`.
- **`git add`는 명시 경로만**(레포에 무관 미추적 파일 다수 — `git add -A` 금지). 커밋 트레일러: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **(프로세스) 서브에이전트는 opus 4.8 사용.**

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `frontend/src/lib/concept/tagLayoutCore.ts` | 순수: 시드·무게중심·반경 | Create |
| `frontend/src/lib/concept/useTagLayout.ts` | d3-force 훅(positions+tagCentroids) | Create |
| `frontend/src/components/canvas/TagMarker.tsx` | 태그 라벨 마커(맵 내부) | Create |
| `frontend/src/components/canvas/ConceptCanvasWorkspace.tsx` | sim 좌표 오버레이·마커·미니맵/리프/포커스 공급 | Modify |
| `frontend/src/components/canvas/ConceptMinimap.tsx` | 입력을 태그 무게중심으로 | Modify |
| `frontend/src/components/canvas/ConceptTreePanel.tsx` | props(groups→tagNodes) | Modify |

프론트 유닛 러너 없음 → 순수(`tagLayoutCore`)는 `npx tsx` 새너티; UI/시뮬은 `tsc`/`eslint` + Playwright(`/tmp/nodi-e2e-QaXC/`).

---

## Task 1: `tagLayoutCore.ts` 순수 헬퍼

**Files:** Create `frontend/src/lib/concept/tagLayoutCore.ts`; Test via `/tmp/taglayout-unit.ts`

**Interfaces (Produces):**
- `tagSeed(tagIndex: number, cardIndex: number): {x:number;y:number}` — 결정론 초기 시드.
- `tagCentroids(nodes: {tag:string;x:number;y:number}[]): Map<string,{x:number;y:number;count:number}>`.
- `clusterRadius(count: number): number` — count↑→반경↑.
- `CENTER = {x, y}`(3200/2·2200/2), `TAG_GOLDEN`, `CARD_W`.

- [ ] **Step 1: 실패 새너티**

`/tmp/taglayout-unit.ts`:
```ts
import { tagSeed, tagCentroids, clusterRadius, CENTER } from "/Users/dhkim/Desktop/ai-rookie/Nodi/frontend/src/lib/concept/tagLayoutCore.ts";

// 결정론 시드
const a = tagSeed(0, 0), b = tagSeed(0, 0);
if (a.x !== b.x || a.y !== b.y) throw new Error("seed not deterministic");
// tag 0 center 근처, tag 1은 떨어짐
const s0 = tagSeed(0, 0), s1 = tagSeed(1, 0);
if (Math.hypot(s0.x - s1.x, s0.y - s1.y) < 200) throw new Error("tags not seeded apart");
// 무게중심
const cs = tagCentroids([
  { tag: "A", x: 100, y: 100 }, { tag: "A", x: 300, y: 300 }, { tag: "B", x: 1000, y: 1000 },
]);
if (Math.round(cs.get("A")!.x) !== 200 || cs.get("A")!.count !== 2) throw new Error("centroid A");
if (cs.get("B")!.count !== 1) throw new Error("centroid B");
// 반경 단조 증가
if (!(clusterRadius(10) > clusterRadius(2))) throw new Error("radius not monotonic");
console.log("PASS", { s0, s1, A: cs.get("A"), r: [clusterRadius(2), clusterRadius(10)] });
```

- [ ] **Step 2: 실패 확인** — `cd frontend && npx tsx /tmp/taglayout-unit.ts` → FAIL(모듈 없음).

- [ ] **Step 3: 구현**

`frontend/src/lib/concept/tagLayoutCore.ts`:
```ts
// 태그 클러스터 레이아웃 순수 헬퍼 — 결정론 시드·무게중심·반경. d3/DOM 독립.
export const CANVAS_W = 3200;
export const CANVAS_H = 2200;
export const CARD_W = 420;
export const CENTER = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
export const TAG_GOLDEN = (Math.PI * (3 - Math.sqrt(5))); // ≈2.399 rad (황금각)

const TAG_R0 = 700; // 태그 시드 나선 반경 계수
const CARD_STEP = 60; // 태그 내 카드 미소 오프셋

// 태그 첫등장 순서 tagIndex(0-based) + 태그 내 카드 순번 cardIndex → 결정론 초기 위치.
// d3의 난수 초기화를 피하려 항상 x/y를 시드한다(재수화 안정).
export function tagSeed(tagIndex: number, cardIndex: number): { x: number; y: number } {
  const r = TAG_R0 * Math.sqrt(Math.max(0, tagIndex));
  const ang = tagIndex * TAG_GOLDEN;
  const bx = CENTER.x + r * Math.cos(ang);
  const by = CENTER.y + r * Math.sin(ang);
  // 카드 순번은 작은 나선으로 흩어 초기 겹침(=jiggle 난수) 방지
  const cr = CARD_STEP * Math.sqrt(cardIndex + 1);
  const cang = (cardIndex + 1) * TAG_GOLDEN;
  return { x: bx + cr * Math.cos(cang), y: by + cr * Math.sin(cang) };
}

// 태그별 노드 좌표 평균(무게중심) + count.
export function tagCentroids(
  nodes: Array<{ tag: string; x: number; y: number }>,
): Map<string, { x: number; y: number; count: number }> {
  const acc = new Map<string, { sx: number; sy: number; n: number }>();
  for (const nd of nodes) {
    const a = acc.get(nd.tag) ?? { sx: 0, sy: 0, n: 0 };
    a.sx += nd.x; a.sy += nd.y; a.n += 1;
    acc.set(nd.tag, a);
  }
  const out = new Map<string, { x: number; y: number; count: number }>();
  for (const [tag, a] of acc) out.set(tag, { x: a.sx / a.n, y: a.sy / a.n, count: a.n });
  return out;
}

// 클러스터 반경(count↑→반경↑) — 미니맵 점 크기·시드 참고용.
export function clusterRadius(count: number): number {
  return 40 + Math.sqrt(Math.max(1, count)) * 30;
}
```

- [ ] **Step 4: 통과 + 타입/린트** — `cd frontend && npx tsx /tmp/taglayout-unit.ts && npx tsc --noEmit && npx eslint src/lib/concept/tagLayoutCore.ts` → PASS·EXIT 0.

- [ ] **Step 5: 커밋**
```bash
git add frontend/src/lib/concept/tagLayoutCore.ts
git commit -m "$(cat <<'EOF'
[feat]: tagLayoutCore — 결정론 태그 시드·무게중심·클러스터 반경(순수)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `useTagLayout.ts` — d3-force 훅

**Files:** Create `frontend/src/lib/concept/useTagLayout.ts`

**Interfaces:**
- Consumes: T1 `tagSeed/tagCentroids/CARD_W`, `d3-force`.
- Produces: `useTagLayout(items: Array<{id:string; tag:string; h:number}>): { positions: Map<string,{x:number;y:number}>; tagCentroids: Map<string,{x:number;y:number;count:number}>; }`.

- [ ] **Step 1: 구현**

`frontend/src/lib/concept/useTagLayout.ts`:
```ts
"use client";

// 태그 클러스터 d3-force 레이아웃 훅. 카드=force 노드: 자기 태그 무게중심으로 응집 +
// forceManyBody(노드 많은 태그가 더 멀리 밀어냄) + forceCollide(무겹침). 좌표는 창발적,
// 결정론 시드(tagSeed)로 재수화 안정. 데이터 변화 시 재가열 → 틱마다 위치 갱신(부드러운 이동).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceSimulation,
  forceManyBody,
  forceCollide,
  type Simulation,
} from "d3-force";
import { tagSeed, tagCentroids as centroidsOf, CARD_W } from "./tagLayoutCore";

interface LNode {
  id: string;
  tag: string;
  h: number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
}

const COHESION = 0.08;  // 태그 무게중심 응집 강도
const CHARGE = -1600;   // 카드 간 반발(음수) — 노드 많은 태그가 총합으로 더 밀어냄
const COLLIDE_GAP = 28; // 무겹침 여백

export function useTagLayout(items: Array<{ id: string; tag: string; h: number }>) {
  const [tick, setTick] = useState(0);
  const simRef = useRef<Simulation<LNode, undefined> | null>(null);
  const nodesRef = useRef<Map<string, LNode>>(new Map());
  // 태그 첫등장 순서(결정론 시드용) — 세션 동안 누적.
  const tagIndexRef = useRef<Map<string, number>>(new Map());
  const tagCountRef = useRef<Map<string, number>>(new Map());

  // 입력 items의 안정 키(순서·태그·개수 변화 감지)
  const sig = items.map((i) => `${i.id}:${i.tag}:${Math.round(i.h)}`).join("|");

  useEffect(() => {
    const nodes = nodesRef.current;
    const seen = new Set<string>();
    for (const it of items) {
      const tag = (it.tag || "").trim() || "기타";
      seen.add(it.id);
      let n = nodes.get(it.id);
      if (!n) {
        if (!tagIndexRef.current.has(tag)) tagIndexRef.current.set(tag, tagIndexRef.current.size);
        const cardIdx = tagCountRef.current.get(tag) ?? 0;
        tagCountRef.current.set(tag, cardIdx + 1);
        const seed = tagSeed(tagIndexRef.current.get(tag)!, cardIdx);
        n = { id: it.id, tag, h: it.h, x: seed.x, y: seed.y };
        nodes.set(it.id, n);
      } else {
        n.tag = tag;
        n.h = it.h;
      }
    }
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);

    const arr = [...nodes.values()];
    // 태그 응집: 매 틱 무게중심 재계산 후 그쪽으로 속도 가함(커스텀 force).
    const cohesion = (alpha: number) => {
      const cs = centroidsOf(arr);
      for (const n of arr) {
        const c = cs.get(n.tag);
        if (!c) continue;
        n.vx = (n.vx ?? 0) + (c.x - n.x) * COHESION * alpha;
        n.vy = (n.vy ?? 0) + (c.y - n.y) * COHESION * alpha;
      }
    };

    let sim = simRef.current;
    if (!sim) {
      sim = forceSimulation<LNode>(arr)
        .force("charge", forceManyBody<LNode>().strength(CHARGE))
        .force("collide", forceCollide<LNode>((n) => Math.hypot(CARD_W, n.h) / 2 + COLLIDE_GAP))
        .force("cohesion", cohesion)
        .alphaMin(0.02)
        .on("tick", () => setTick((t) => (t + 1) % 1_000_000));
      simRef.current = sim;
    } else {
      sim.nodes(arr);
      sim.force("collide", forceCollide<LNode>((n) => Math.hypot(CARD_W, n.h) / 2 + COLLIDE_GAP));
      sim.force("cohesion", cohesion);
      sim.alpha(0.9).restart(); // 재가열 → 전체 재배치 애니메이션
    }
    return () => {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  useEffect(() => () => { simRef.current?.stop(); }, []);

  const positions = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of nodesRef.current.values()) m.set(n.id, { x: n.x, y: n.y });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const tagCentroids = useMemo(() => centroidsOf([...nodesRef.current.values()]), [tick]);

  return { positions, tagCentroids };
}
```

- [ ] **Step 2: 타입/린트** — `cd frontend && npx tsc --noEmit && npx eslint src/lib/concept/useTagLayout.ts` → EXIT 0. (d3-force 타입은 `@types/d3` 포함. 없으면 `d3-force`는 `@types/d3-force` 필요 — 이미 `@types/d3` 존재로 커버.)

- [ ] **Step 3: 커밋**
```bash
git add frontend/src/lib/concept/useTagLayout.ts
git commit -m "$(cat <<'EOF'
[feat]: useTagLayout — d3-force 태그 클러스터(응집+count반발+무겹침, 결정론 시드)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 지도 통합 — `TagMarker` + 워크스페이스 sim 좌표 오버레이

**Files:** Create `frontend/src/components/canvas/TagMarker.tsx`; Modify `frontend/src/components/canvas/ConceptCanvasWorkspace.tsx`

- [ ] **Step 1: `TagMarker` 구현**

`frontend/src/components/canvas/TagMarker.tsx`:
```tsx
"use client";

// 태그 라벨 마커 — 태그 무게중심에 렌더(NoteCanvas 내부, 팬/줌 따라감). 카드 아래 레이어.
import { CARD_W } from "@/lib/concept/tagLayoutCore";

export default function TagMarker({
  tag,
  x,
  y,
  count,
}: {
  tag: string;
  x: number;
  y: number;
  count: number;
}) {
  return (
    <div
      data-testid="tag-marker"
      style={{
        position: "absolute",
        left: x + CARD_W / 2 - 90,
        top: y - 44,
        width: 180,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
        padding: "4px 12px",
        background: "rgba(43,38,32,.06)",
        border: "1px solid rgba(43,38,32,.14)",
        borderRadius: 999,
        fontFamily: "var(--font-title)",
        fontSize: 15,
        color: "var(--ink)",
        pointerEvents: "none",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      <span>{tag}</span>
      <span style={{ opacity: 0.6, fontSize: 12 }}>{count}</span>
    </div>
  );
}
```

- [ ] **Step 2: 워크스페이스 — useTagLayout 배선 + sim 좌표 오버레이 + 마커**

`ConceptCanvasWorkspace.tsx`:
1) import: `import { useTagLayout } from "@/lib/concept/useTagLayout";` `import TagMarker from "./TagMarker";`
2) 훅 호출(비-pending 개념만 레이아웃):
```tsx
  const layoutItems = concepts
    .filter((c) => !c.pending)
    .map((c) => ({ id: c.id, tag: c.cluster || "기타", h: c.h ?? 216 }));
  const { positions, tagCentroids } = useTagLayout(layoutItems);
```
3) 카드 렌더를 sim 좌표로 오버레이(없으면 기존 좌표 폴백):
```tsx
        {concepts.map((c) => {
          const p = positions.get(c.id);
          const laid = p ? { ...c, x: p.x, y: p.y } : c;
          return <ConceptCard key={c.id} concept={laid} highlighted={c.id === activeId} />;
        })}
        {/* 태그 마커 — 무게중심에 */}
        {[...tagCentroids.entries()].map(([tag, c]) => (
          <TagMarker key={tag} tag={tag} x={c.x} y={c.y} count={c.count} />
        ))}
```
4) `MapLoadingIndicator`/리프/미니맵에 넘기는 좌표도 sim 우선으로: 리프 렌더 시 `leafNodes`의 anchor 개념 위치를 `positions`로 보정(anchor conceptId의 sim 위치 기준 오프셋). (leafNodes.x/y가 서버/스트림 좌표라면 sim으로 덮어씀 — anchor conceptId 없으면 기존 유지.)

- [ ] **Step 3: 타입/린트 + E2E**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/components/canvas/TagMarker.tsx src/components/canvas/ConceptCanvasWorkspace.tsx`
Expected: EXIT 0.
Runtime(Playwright): 같은 태그 조밀·다른 태그 분리, 태그 마커(`data-testid="tag-marker"`) 태그당 1개, 큰 클러스터일수록 이웃과 더 멀다, 무겹침. 환경 제약 시 DONE_WITH_CONCERNS.

- [ ] **Step 4: 커밋**
```bash
git add frontend/src/components/canvas/TagMarker.tsx frontend/src/components/canvas/ConceptCanvasWorkspace.tsx
git commit -m "$(cat <<'EOF'
[feat]: 지도 태그 마커 + 워크스페이스 d3-force sim 좌표 오버레이

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 개념트리(미니맵)를 태그 무게중심으로

**Files:** Modify `frontend/src/components/canvas/ConceptMinimap.tsx`, `frontend/src/components/canvas/ConceptTreePanel.tsx`, `frontend/src/components/canvas/ConceptCanvasWorkspace.tsx`

- [ ] **Step 1: `ConceptMinimap` 입력을 태그 무게중심으로**

`ConceptMinimap.tsx`의 `groups`/`concepts` 기반 `groupCentroids` 대신, props로 받은 태그 무게중심 배열로 노드 구성. props 교체:
```tsx
export default function ConceptMinimap({
  tagNodes,        // Array<{ tag:string; x:number; y:number; count:number }>
  camera,
  viewport,
  onFocus,
}: {
  tagNodes: Array<{ tag: string; x: number; y: number; count: number }>;
  camera: { x: number; y: number; scale: number };
  viewport: { w: number; h: number };
  onFocus: (target: { x: number; y: number }) => void;
}) {
  const nodes = tagNodes.map((t) => ({ id: t.tag, label: t.tag, count: t.count, wx: t.x, wy: t.y }));
  // 이하 worldBBox/fitTransform/scaleLinear/viewportRectPx 재사용 — nodes[].wx/wy로 매핑,
  // 반경 clamp(6+√count*3,6,22), 라벨=tag, 클릭 onFocus({x:wx,y:wy}). activeId 분기는 제거.
  ...
}
```
(`groupCentroids` import·`activeId`·`Concept`/`ConceptGroup` import 제거. `minimapLayout`의 worldBBox/fitTransform/project/viewportRectPx는 그대로 사용.)

- [ ] **Step 2: `ConceptTreePanel` props 교체**

`groups`/`concepts`/`activeId` → `tagNodes` 하나로. 본문 `<ConceptMinimap tagNodes=… camera=… viewport=… onFocus=… />`. 헤더 개념 수는 `tagNodes.length`로.

- [ ] **Step 3: 워크스페이스에서 tagCentroids 공급**

`ConceptTreePanel` 사용부를:
```tsx
      <ConceptTreePanel
        open={treeOpen}
        onToggle={() => setTreeOpen((v) => !v)}
        tagNodes={[...tagCentroids.entries()].map(([tag, c]) => ({ tag, x: c.x, y: c.y, count: c.count }))}
        camera={camera}
        viewport={vp()}
        onFocus={(target) => setCamera(focusCamera(vp(), { x: target.x, y: target.y }, 1))}
      />
```
`groups`/`buildGroups`가 이제 미니맵에 안 쓰이면 워크스페이스에서 그 전달 제거(‑useConceptStream의 groups 자체는 남겨도 무방).

- [ ] **Step 4: 타입/린트 + E2E**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/components/canvas/ConceptMinimap.tsx src/components/canvas/ConceptTreePanel.tsx src/components/canvas/ConceptCanvasWorkspace.tsx`
Expected: EXIT 0.
Runtime(Playwright): 미니맵이 **태그**를 점으로(1태그=1점, count 크기), 점 클릭 → 그 클러스터로 팬. 새로고침 후에도 태그 표시.

- [ ] **Step 5: 커밋**
```bash
git add frontend/src/components/canvas/ConceptMinimap.tsx frontend/src/components/canvas/ConceptTreePanel.tsx frontend/src/components/canvas/ConceptCanvasWorkspace.tsx
git commit -m "$(cat <<'EOF'
[feat]: 개념트리 미니맵을 태그 무게중심으로(1태그=1점, 클릭 팬)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- §2 프론트 권위·서버 좌표 무시 → T3(오버레이). ✓
- §3 useTagLayout(응집+count반발+무겹침+결정론 시드) → T1(순수)·T2(훅). ✓
- §4 TagMarker 지도 표시 → T3. ✓
- §5 미니맵=태그 → T4. ✓
- §6 기능 적응(카드 좌표·리프·포커스) → T3 Step2·4. ✓
- §9 테스트(순수 새너티·E2E) → T1·T3·T4. ✓
- §10 비범위(서버 앵커 물리제거·위치영속 제외). ✓

**2. Placeholder scan:** T3 Step2-4·T4 Step1은 대형 파일 국소 편집이라 "교체 지점+코드"로 구체화(전체 재출력 대신 정확한 삽입/치환 지점 명시). 코드 스텝엔 실제 코드. ✓

**3. Type consistency:**
- `useTagLayout(items:{id,tag,h}[]) → {positions:Map, tagCentroids:Map}` — T2 정의 ↔ T3/T4 사용 일치. ✓
- `tagSeed/tagCentroids/clusterRadius/CARD_W/CENTER` — T1 정의 ↔ T2 import 일치. ✓
- `ConceptMinimap` props `tagNodes` — T4 Step1 정의 ↔ Step3 전달 일치. `concept.cluster`(파서 태그) 존재 확인(Concept.cluster). ✓
- `positions.get(id)` 폴백(sim 미확정 시 기존 c) — 안전. ✓

**주의(실행):** T2 d3-force 훅은 상태적/리렌더 민감 — 각 태스크 종료 시 `tsc`/`eslint` + (가능하면) Playwright로 시뮬 동작 관찰. `@types/d3-force`가 없으면 `d3-force` 타입 에러 가능 → 있으면 설치(package.json devDeps, 명시 경로 커밋).
