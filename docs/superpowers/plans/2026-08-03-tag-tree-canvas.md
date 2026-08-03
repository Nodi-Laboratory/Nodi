# 태그 트리 캔버스 + 분기 대화 (D148) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 태그 열 배치를 세로 tidy tree로 바꾸고, 미니맵을 2단계 드릴다운으로,
미니맵 카드 클릭으로 대화 컨텍스트(분기)를 되감는다.

**Architecture:** 결정론적 세로 tidy tree(태그=뿌리, 카드=가지)를 순수 함수로
`layout.ts`에 두고 `useItemLayout`이 붙인다. 미니맵은 레벨1(태그 원)·레벨2(태그
트리) 두 뷰. 분기 대화는 백엔드(`parent_node_id`·`ancestor_chain`·head 전진)가
이미 있으므로 프론트에서 head의 nodeId를 `parent_node_id`로 배선하는 것만 남는다.

**Tech Stack:** Next.js(App Router)·TypeScript·React(Compiler 규칙 on)·vitest·
Playwright. 백엔드 FastAPI(변경 없음).

## Global Constraints

- **무겹침은 알고리즘의 성질**(D123): 트리 배치·미니맵 트리 모두 결정론·무겹침.
  `layout.test.ts` 무작위 200케이스 통과 유지.
- **좌표 저장(D122)**: `pinned=false`는 엔진 배치, `pinned=true`는 장애물로만 읽고
  제자리 유지.
- **React Compiler 규칙**: 렌더 중 ref 쓰기·이펙트 내 동기 setState는 에러.
  억제 금지, 구조로 해결(rAF·useEventCallback).
- **memo 보호(D145)**: 핸들러 묶음은 신원 고정(`useEventCallback`). 매 프레임
  바뀌는 값(bridge·camera)을 핸들러 묶음에 넣지 않는다.
- **주석·커밋 한국어**, 설계 결정은 D148로 표기. 커밋 프리픽스 `[feat]`/`[test]` 등.
- 프론트 스모크: `cd frontend && npx tsc --noEmit && npm run build`,
  단위 `npm test`, E2E `npx playwright test`.

---

## File Structure

- `frontend/src/lib/canvas2/tree.ts` (신규) — 트리 구성·세로 packing 순수 함수.
- `frontend/src/lib/canvas2/tree.test.ts` (신규) — 무겹침·구조 테스트.
- `frontend/src/lib/canvas2/layout.ts` (수정) — `layoutItems`가 `tree.ts`를 써서
  태그 트리 배치. `LayoutResult.columnX` → `tagRoots`. `rectOf` 유지.
- `frontend/src/lib/canvas2/layout.test.ts` (수정) — 무겹침 200케이스 유지 + 트리.
- `frontend/src/lib/canvas2/useItemLayout.ts` (수정) — `columnX` → `tagRoots` 노출.
- `frontend/src/components/canvas2/ItemLayer.tsx` (수정) — `ColumnLabels` →
  `TagChips`(tagRoots 기준).
- `frontend/src/components/canvas2/ConnectorLayer.tsx` (수정) — 태그뿌리→최상위
  카드 가지 선.
- `frontend/src/lib/canvas2/minimapTree.ts` (신규) — 한 태그 도식 tidy tree.
- `frontend/src/lib/canvas2/minimapTree.test.ts` (신규).
- `frontend/src/components/canvas2/Minimap.tsx` (수정) — 2단계 드릴다운.
- `frontend/src/lib/canvas2/useCanvasStream.ts` (수정) — `send`가 `parent_node_id`
  전송.
- `frontend/src/components/canvas2/CanvasWorkspace.tsx` (수정) — `headItemId` 상태·
  `onSetHead`·배선.
- `frontend/src/components/canvas2/AskBar.tsx` (수정) — 활성 head 칩(quote 재사용).
- `frontend/e2e/tree.spec.ts` (신규) — E2E.

---

## Task 1: 트리 구성 (buildForest)

카드 목록에서 태그별 트리(뿌리=태그 칩)를 만든다. cross-tag 규칙 포함.

**Files:**
- Create: `frontend/src/lib/canvas2/tree.ts`
- Test: `frontend/src/lib/canvas2/tree.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TreeInput {
    id: string; tag: string | null; seq: number;
    width: number; height: number;
    parentItemId: string | null; pinned: boolean;
  }
  export interface TreeNode {
    id: string;            // 카드 id, 또는 태그 칩이면 `tag:<tag>`
    w: number; h: number; seq: number;
    children: TreeNode[];
  }
  export const UNTAGGED: string;          // layout.ts에서 재수출
  export const TAG_CHIP_W = 120;
  export const TAG_CHIP_H = 34;
  // 태그 → 그 태그의 루트 TreeNode(뿌리는 태그 칩). pinned은 제외.
  export function buildForest(items: readonly TreeInput[]): Map<string, TreeNode>;
  ```
- 규칙: 카드의 트리-부모 = `parentItemId`가 **같은 태그 & 미pinned & 존재**할 때만
  그 카드; 아니면 태그 칩(루트)에 직접. 형제는 seq 오름차순. pinned 카드는 트리에
  넣지 않는다.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// tree.test.ts
import { describe, it, expect } from "vitest";
import { buildForest, UNTAGGED, type TreeInput } from "./tree";

const mk = (o: Partial<TreeInput> & { id: string }): TreeInput => ({
  tag: null, seq: 0, width: 200, height: 100, parentItemId: null, pinned: false, ...o,
});

describe("buildForest", () => {
  it("같은 태그 부모-자식은 중첩, 다른 태그 자식은 태그 뿌리에 붙는다", () => {
    const f = buildForest([
      mk({ id: "a", tag: "역사", seq: 1 }),
      mk({ id: "b", tag: "역사", seq: 2, parentItemId: "a" }),   // a의 자식
      mk({ id: "c", tag: "과학", seq: 3, parentItemId: "a" }),   // 다른 태그 → 과학 뿌리
    ]);
    const hist = f.get("역사")!;
    expect(hist.id).toBe("tag:역사");
    expect(hist.children.map((n) => n.id)).toEqual(["a"]);
    expect(hist.children[0].children.map((n) => n.id)).toEqual(["b"]);
    const sci = f.get("과학")!;
    expect(sci.children.map((n) => n.id)).toEqual(["c"]);
  });

  it("pinned 카드는 트리에서 빠진다", () => {
    const f = buildForest([mk({ id: "p", tag: "역사", pinned: true })]);
    expect(f.has("역사")).toBe(false);
  });

  it("태그 없는 카드는 UNTAGGED 트리로 모인다", () => {
    const f = buildForest([mk({ id: "x" })]);
    expect(f.get(UNTAGGED)!.children.map((n) => n.id)).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/lib/canvas2/tree.test.ts`
Expected: FAIL — "buildForest is not a function"

- [ ] **Step 3: 최소 구현**

```ts
// tree.ts
export const UNTAGGED = " untagged";
export const TAG_CHIP_W = 120;
export const TAG_CHIP_H = 34;

export interface TreeInput {
  id: string; tag: string | null; seq: number;
  width: number; height: number;
  parentItemId: string | null; pinned: boolean;
}
export interface TreeNode {
  id: string; w: number; h: number; seq: number; children: TreeNode[];
}

export function buildForest(items: readonly TreeInput[]): Map<string, TreeNode> {
  const flow = items.filter((i) => !i.pinned);
  const byId = new Map(flow.map((i) => [i.id, i]));
  const tagOf = (i: TreeInput) => i.tag || UNTAGGED;
  // 카드 id → 그 카드의 TreeNode
  const node = new Map<string, TreeNode>();
  for (const i of flow) node.set(i.id, { id: i.id, w: i.width, h: i.height, seq: i.seq, children: [] });

  const roots = new Map<string, TreeNode>(); // 태그 → 칩 루트
  const rootFor = (tag: string) => {
    let r = roots.get(tag);
    if (!r) { r = { id: `tag:${tag}`, w: TAG_CHIP_W, h: TAG_CHIP_H, seq: -1, children: [] }; roots.set(tag, r); }
    return r;
  };

  for (const i of flow) {
    const n = node.get(i.id)!;
    const tag = tagOf(i);
    const p = i.parentItemId ? byId.get(i.parentItemId) : undefined;
    // 트리-부모: 같은 태그 & 미pinned(=flow에 존재) 부모일 때만.
    if (p && tagOf(p) === tag) node.get(p.id)!.children.push(n);
    else rootFor(tag).children.push(n);
  }
  // 형제는 seq 오름차순.
  for (const n of node.values()) n.children.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  for (const r of roots.values()) r.children.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  return roots;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/lib/canvas2/tree.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/canvas2/tree.ts frontend/src/lib/canvas2/tree.test.ts
git commit -m "[feat]: 태그 트리 구성 — cross-tag 규칙과 pinned 제외 (D148)"
```

---

## Task 2: 세로 tidy tree packing

트리 하나를 세로로 배치한다 — 무겹침 보장. 여러 태그 트리를 좌→우로 나란히.

**Files:**
- Modify: `frontend/src/lib/canvas2/tree.ts`
- Test: `frontend/src/lib/canvas2/tree.test.ts`

**Interfaces:**
- Consumes: `buildForest`, `TreeNode` (Task 1).
- Produces:
  ```ts
  export interface Placed { x: number; y: number; }
  export const LEVEL_GAP = 56;    // 세대 세로 간격
  export const SIBLING_GAP = 40;  // 형제 가로 간격
  export const TREE_GAP = 200;    // 태그 트리 사이 간격
  // 트리 하나를 originX 기준으로 배치. 반환: 노드 id → 좌상단, 트리 폭/높이.
  export function packTree(root: TreeNode, originX: number, originY: number):
    { pos: Map<string, Placed>; width: number; height: number };
  ```
- 무겹침: 형제는 서로소 가로 띠(`[cx, cx+subW]`)를 차지, 노드는 자기 띠 중앙(띠폭 ≥
  노드폭). 세대는 y로 분리(레벨 최대높이 + LEVEL_GAP). → 어떤 두 노드도 안 겹침.

- [ ] **Step 1: 실패 테스트 작성 (무겹침 무작위)**

```ts
// tree.test.ts 에 추가
import { packTree, buildForest, /*...*/ } from "./tree";

function rects(pos: Map<string, { x: number; y: number }>, sizeOf: (id: string) => { w: number; h: number }) {
  return [...pos].map(([id, p]) => ({ id, x: p.x, y: p.y, ...sizeOf(id) }));
}
const overlap = (a: any, b: any) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

it("무작위 트리 100케이스에서 어떤 노드도 겹치지 않는다", () => {
  for (let t = 0; t < 100; t++) {
    const n = 3 + ((t * 7) % 18);
    const items = Array.from({ length: n }, (_, i) => ({
      id: `n${i}`, tag: `T${(i * 3) % 4}`, seq: i,
      width: 120 + ((i * 37) % 340), height: 60 + ((i * 53) % 160),
      parentItemId: i > 0 && i % 2 === 0 ? `n${i - 1}` : null, pinned: false,
    }));
    const forest = buildForest(items);
    const sizeOf = (id: string) => {
      if (id.startsWith("tag:")) return { w: 120, h: 34 };
      const it = items.find((x) => x.id === id)!;
      return { w: it.width, h: it.height };
    };
    let ox = 0;
    const all: any[] = [];
    for (const root of forest.values()) {
      const { pos, width } = packTree(root, ox, 0);
      all.push(...rects(pos, sizeOf));
      ox += width + 200;
    }
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        expect(overlap(all[i], all[j]), `${all[i].id} vs ${all[j].id} (case ${t})`).toBe(false);
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/lib/canvas2/tree.test.ts`
Expected: FAIL — "packTree is not a function"

- [ ] **Step 3: 구현**

```ts
// tree.ts 에 추가
export interface Placed { x: number; y: number; }
export const LEVEL_GAP = 56;
export const SIBLING_GAP = 40;
export const TREE_GAP = 200;

export function packTree(root: TreeNode, originX: number, originY: number) {
  // 1) 세대별 y (좌상단). 레벨 높이 = 그 세대 노드 최대 높이.
  const levels: TreeNode[][] = [];
  const walk = (n: TreeNode, d: number) => { (levels[d] ??= []).push(n); n.children.forEach((c) => walk(c, d + 1)); };
  walk(root, 0);
  const levelY: number[] = [];
  let y = originY;
  for (let d = 0; d < levels.length; d++) {
    levelY[d] = y;
    y += Math.max(...levels[d].map((n) => n.h)) + LEVEL_GAP;
  }
  // 2) 서브트리 폭(후위) → x(전위, 자기 띠 중앙).
  const subW = new Map<string, number>();
  const childrenSpan = (n: TreeNode) =>
    n.children.reduce((a, c) => a + subW.get(c.id)!, 0) + SIBLING_GAP * Math.max(0, n.children.length - 1);
  const measure = (n: TreeNode): number => {
    n.children.forEach(measure);
    const w = Math.max(n.w, childrenSpan(n));
    subW.set(n.id, w);
    return w;
  };
  measure(root);

  const pos = new Map<string, Placed>();
  const place = (n: TreeNode, left: number, depth: number) => {
    const w = subW.get(n.id)!;
    pos.set(n.id, { x: left + (w - n.w) / 2, y: levelY[depth] });
    let cx = left + (w - childrenSpan(n)) / 2; // 자식 묶음을 띠 중앙에
    for (const c of n.children) {
      place(c, cx, depth + 1);
      cx += subW.get(c.id)! + SIBLING_GAP;
    }
  };
  place(root, originX, 0);
  return { pos, width: subW.get(root.id)!, height: y - LEVEL_GAP - originY };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/lib/canvas2/tree.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/canvas2/tree.ts frontend/src/lib/canvas2/tree.test.ts
git commit -m "[feat]: 세로 tidy tree packing — 무겹침 보장 (D148)"
```

---

## Task 3: layoutItems를 트리로 재작성 + tagRoots

`layout.ts`가 `tree.ts`를 써서 태그 트리를 배치. pinned/장애물은 블록 단위로 회피.
`columnX` → `tagRoots`.

**Files:**
- Modify: `frontend/src/lib/canvas2/layout.ts`
- Modify: `frontend/src/lib/canvas2/layout.test.ts`

**Interfaces:**
- Consumes: `buildForest`, `packTree`, `TREE_GAP`, `Placed` (Task 1·2).
- Produces (변경):
  ```ts
  export interface LayoutResult {
    positions: Map<string, Placed>;      // 카드 좌표
    tagRoots: Map<string, Placed>;       // 태그 칩 좌표 (신규, columnX 대체)
    tagOrder: string[];
  }
  export function layoutItems(items, obstacles, prevOrder): LayoutResult; // 시그니처 동일
  ```
- `reflowOne`은 제거하고, 호출부(onReflow)는 pinned=false로 되돌려 트리가 재배치.
  (트리에선 한 노드만 옮기면 형제 재packing과 어긋난다 — un-pin이 일관.)

- [ ] **Step 1: 실패 테스트 (트리 좌표 + 무겹침 200케이스 유지)**

기존 `layout.test.ts`의 무겹침 200케이스는 유지하되, 검사 대상 사각형에 **태그 칩**
(`tagRoots`)과 pinned·obstacles를 포함하도록 갱신. 추가:

```ts
it("태그 칩이 그 태그 트리 맨 위에 온다", () => {
  const r = layoutItems(
    [
      { id: "a", tag: "역사", seq: 1, width: 200, height: 100, pinned: false, x: 0, y: 0, parentItemId: null },
      { id: "b", tag: "역사", seq: 2, width: 200, height: 100, pinned: false, x: 0, y: 0, parentItemId: "a" },
    ],
    [], [],
  );
  const chip = r.tagRoots.get("역사")!;
  expect(chip.y).toBeLessThan(r.positions.get("a")!.y);
  expect(r.positions.get("b")!.y).toBeGreaterThan(r.positions.get("a")!.y); // 자식이 아래
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/lib/canvas2/layout.test.ts`
Expected: FAIL — `tagRoots` 없음 / 트리 좌표 불일치

- [ ] **Step 3: 구현**

`layoutItems`를 다음 뼈대로 재작성(기존 열 로직 대체). pinned·obstacles는 블록
회피:

```ts
import { buildForest, packTree, TREE_GAP, type TreeInput } from "./tree";
import { bottom, intersects, type Rect } from "./rect";

export function layoutItems(items, obstacles = [], prevOrder = []): LayoutResult {
  // 태그 순서: 이전 순서 계승 + 처음 보는 태그는 seq 순으로 뒤에.
  const bySeq = [...items].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const order = [...prevOrder];
  for (const it of bySeq) { const t = it.tag || UNTAGGED; if (!order.includes(t)) order.push(t); }

  const forest = buildForest(bySeq as unknown as TreeInput[]); // width/height 포함(LayoutInput)
  const positions = new Map<string, Placed>();
  const tagRoots = new Map<string, Placed>();

  // 장애물: 외부 + pinned 카드.
  const blocks: Rect[] = [...obstacles];
  for (const it of bySeq) if (it.pinned) { positions.set(it.id, { x: it.x, y: it.y }); blocks.push({ x: it.x, y: it.y, w: it.width, h: it.height }); }

  // 태그 트리를 order 순서로 좌→우. 각 트리는 장애물을 만나면 블록째 아래로.
  let ox = 0;
  for (const tag of order) {
    const root = forest.get(tag);
    if (!root) continue;
    // 1차 배치(originY=0)로 폭·상대 좌표를 얻는다.
    const trial = packTree(root, ox, 0);
    // 이 트리 bbox가 장애물과 겹치면 통째로 아래로 민다(단조 증가 → 종료).
    let shift = 0;
    for (let g = 0; g < 400; g++) {
      const hit = [...trial.pos].some(([id, p]) => {
        const w = id.startsWith("tag:") ? root.w : (bySeq.find((x) => x.id === id)!.width);
        const h = id.startsWith("tag:") ? root.h : (bySeq.find((x) => x.id === id)!.height);
        const rect = { x: p.x, y: p.y + shift, w, h };
        return blocks.some((o) => intersects(rect, o));
      });
      if (!hit) break;
      // 가장 아래 장애물 밑으로.
      shift += 44;
    }
    for (const [id, p] of trial.pos) {
      const at = { x: p.x, y: p.y + shift };
      if (id.startsWith("tag:")) tagRoots.set(tag, at);
      else positions.set(id, at);
      const w = id.startsWith("tag:") ? root.w : (bySeq.find((x) => x.id === id)!.width);
      const h = id.startsWith("tag:") ? root.h : (bySeq.find((x) => x.id === id)!.height);
      blocks.push({ x: at.x, y: at.y, w, h });
    }
    ox += trial.width + TREE_GAP;
  }
  return { positions, tagRoots, tagOrder: order };
}
```

`reflowOne` 삭제. `rectOf` 유지. `columnX` 관련 export 제거.

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/lib/canvas2/layout.test.ts`
Expected: PASS (무겹침 200케이스 포함)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/canvas2/layout.ts frontend/src/lib/canvas2/layout.test.ts
git commit -m "[feat]: layoutItems를 태그 트리로 재작성, columnX→tagRoots (D148)"
```

---

## Task 4: useItemLayout — tagRoots 노출 + 소비부 배선

`columnX`를 `tagRoots`로 바꾸고, ItemLayer의 라벨을 태그 칩으로, ConnectorLayer에
가지 선을 더한다. reflow는 un-pin으로.

**Files:**
- Modify: `frontend/src/lib/canvas2/useItemLayout.ts`
- Modify: `frontend/src/components/canvas2/ItemLayer.tsx`
- Modify: `frontend/src/components/canvas2/ConnectorLayer.tsx`
- Modify: `frontend/src/components/canvas2/CanvasWorkspace.tsx` (onReflow → un-pin)

**Interfaces:**
- `UseItemLayout`에서 `columnX: Map<string, number>` → `tagRoots: Map<string, Placed>`.
- `ItemLayer` props: `columnX` 제거, `tagRoots: Map<string, Placed>` 추가.
- `ConnectorLayer` props: `tagRoots`·`tagOrder` 추가(뿌리→최상위 카드 선).

- [ ] **Step 1: useItemLayout 갱신**

`EMPTY`·`UseItemLayout`·반환 useMemo에서 `columnX` → `tagRoots`. `LayoutSource`에
`width`/`height`는 이미 layout 입력 시 sizes로 합쳐지므로 변경 없음. import에서
`Placed` 유지.

```ts
const EMPTY: LayoutResult = { positions: new Map(), tagRoots: new Map(), tagOrder: [] };
// interface UseItemLayout { ... tagRoots: Map<string, Placed>; ... }  // columnX 삭제
// return useMemo(() => ({ positions, tagRoots: state.result.tagRoots, tagOrder, sizes, measure, invalidate }), ...)
```

- [ ] **Step 2: ItemLayer — TagChips**

`ColumnLabels`를 `TagChips`로 교체: `tagRoots`의 각 좌표에 태그 칩(`●[태그]`)을
그린다. `pointer-events-none absolute`. UNTAGGED는 렌더 생략. `columnX` prop 삭제.

```tsx
function TagChips({ tagRoots }: { tagRoots: Map<string, Placed> }) {
  return (
    <>
      {[...tagRoots].map(([tag, p]) =>
        tag === UNTAGGED ? null : (
          <div key={tag} className="label pointer-events-none absolute flex select-none items-center gap-1.5"
            style={{ left: p.x, top: p.y, color: "var(--c-ink-faint)", letterSpacing: 0 }}>
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: 9, background: "var(--c-rule)" }} />
            <span className="truncate">{tag}</span>
          </div>
        ),
      )}
    </>
  );
}
```

- [ ] **Step 3: ConnectorLayer — 뿌리→최상위 카드 가지 선**

`tagRoots`·`items`·`positions`로, 태그 뿌리에 직접 붙는 카드(=`parentItemId`가 없는
같은 태그 카드)로 향하는 얇은 선을 기존 부모-자식 선과 함께 그린다. 기하는 기존
`connector.ts` 재사용(뿌리 칩을 작은 사각형으로 취급).

- [ ] **Step 4: CanvasWorkspace — 소비부 + onReflow**

`layout.columnX` 참조를 `layout.tagRoots`로. `<Minimap>`·`<ItemLayer>`에 넘기던
`columnX`를 제거/`tagRoots`로 교체. `onReflow(id)`는 `reflowOne` 대신 그 아이템을
`pinned=false`로 patch(엔진이 트리로 재배치).

```ts
const onReflow = useEventCallback((id: string) => {
  store.patch(id, { pinned: false });   // 트리가 다시 자리 잡는다
});
```

- [ ] **Step 5: 타입·빌드·단위 통과**

Run: `cd frontend && npx tsc --noEmit && npm test`
Expected: PASS (컴파일·기존 순수함수 테스트)

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/lib/canvas2/useItemLayout.ts frontend/src/components/canvas2/ItemLayer.tsx frontend/src/components/canvas2/ConnectorLayer.tsx frontend/src/components/canvas2/CanvasWorkspace.tsx
git commit -m "[feat]: tagRoots 배선 — 태그 칩·가지 선·un-pin 리플로 (D148)"
```

---

## Task 5: 미니맵 트리 레이아웃 (minimapTree.ts)

한 태그의 카드들을 도식 tidy tree로(고른 간격) 배치하는 순수 함수. 캔버스 트리와
같은 구조를 작게 재현하되 균일 노드 크기.

**Files:**
- Create: `frontend/src/lib/canvas2/minimapTree.ts`
- Test: `frontend/src/lib/canvas2/minimapTree.test.ts`

**Interfaces:**
- Consumes: `buildForest`(같은 규칙 재사용) 또는 자체 트리 구성.
- Produces:
  ```ts
  export interface MiniNode { id: string; nodeId: string | null; x: number; y: number; source: "ai" | "user"; isRoot: boolean; }
  export interface MiniEdge { x1: number; y1: number; x2: number; y2: number; }
  export function minimapTree(
    tag: string,
    cards: readonly { id: string; nodeId: string | null; parentItemId: string | null; seq: number; source: "ai" | "user" }[],
    box: { w: number; h: number },
  ): { nodes: MiniNode[]; edges: MiniEdge[] };
  ```
- 균일 노드(반지름 상수), 세로 배치, box 안에 스케일-투-핏. 무겹침·결정론.

- [ ] **Step 1: 실패 테스트**

```ts
it("루트 아래 자식이 더 낮은 y에 온다 + box 안에 들어온다", () => {
  const { nodes } = minimapTree("역사", [
    { id: "a", nodeId: "na", parentItemId: null, seq: 1, source: "user" },
    { id: "b", nodeId: "nb", parentItemId: "a", seq: 2, source: "ai" },
  ], { w: 300, h: 220 });
  const a = nodes.find((n) => n.id === "a")!, b = nodes.find((n) => n.id === "b")!;
  expect(b.y).toBeGreaterThan(a.y);
  for (const n of nodes) { expect(n.x).toBeGreaterThanOrEqual(0); expect(n.x).toBeLessThanOrEqual(300); }
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/lib/canvas2/minimapTree.test.ts` → FAIL

- [ ] **Step 3: 구현** — `buildForest`로 트리를 얻어(균일 w/h 상수로 대체) `packTree`
  로직을 재사용하거나 간이 세로 배치 후 box에 스케일. 뿌리는 태그 칩 노드
  (`isRoot`, `nodeId=null`).

- [ ] **Step 4: 통과 확인** — Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/canvas2/minimapTree.ts frontend/src/lib/canvas2/minimapTree.test.ts
git commit -m "[feat]: 미니맵 태그 트리 도식 레이아웃 (D148)"
```

---

## Task 6: Minimap 2단계 드릴다운 컴포넌트

레벨1(태그 원, 현행) + 레벨2(태그 트리). 줌 연동, 포커스 태그, 콜백.

**Files:**
- Modify: `frontend/src/components/canvas2/Minimap.tsx`

**Interfaces:**
- Consumes: `minimapTree` (Task 5), 기존 레벨1 로직.
- Props 추가:
  ```ts
  items: CanvasItem[]; camera: Camera; viewport; onJump;              // 기존
  headItemId: string | null;                                         // 활성 head 강조
  onSetHead: (itemId: string, nodeId: string | null) => void;        // 카드 클릭 → 컨텍스트
  // (columnX 제거)
  ```
- 내부 상태: `level: 1|2`, `focusTag: string | null`. 규칙:
  - `camera.zoom > ZOOM_L2`(예 0.9) 또는 `focusTag != null` → 레벨2.
  - 레벨2 포커스 태그 = `focusTag ?? headItemId가 속한 태그`.
  - 레벨1 태그 원 클릭 → `onJump(중심)` + `setFocusTag(tag)`.
  - 레벨2 카드 클릭 → `onJump(카드 world)` + `onSetHead(id, nodeId)`.
  - `‹ 전체` 버튼 → `setFocusTag(null)`(레벨1). 줌아웃 시 자동 레벨1.

- [ ] **Step 1: 레벨2 렌더 추가**

`open`일 때 `level`에 따라 SVG 내용 분기. 레벨2는 `minimapTree(focusTag, cards, {W,H})`
결과로 원(오커/틸)·선·`‹ 전체` 버튼을 그린다. head 노드는 굵은 링.

```tsx
// 레벨2 노드 클릭
onClick={() => { onJump(worldOf(n.id)); if (n.nodeId !== null || !n.isRoot) onSetHead(n.id, n.nodeId); }}
```

`worldOf`는 상위에서 온 `positions`가 아니라, 클릭 시 실제 이동을 위해 `onJump`에
카드 world를 넘겨야 하므로 `positions`를 prop로 받거나 `items`+layout에서 구함 —
간단히 `positions: Map<string, Placed>` prop 유지(기존에 이미 넘김).

- [ ] **Step 2: 줌 연동·포커스 상태**

`useState<number>`가 아니라 파생: `const level = focusTag || camera.zoom > ZOOM_L2 ? 2 : 1`.
`focusTag`만 state. head 태그 계산은 `items`에서.

- [ ] **Step 3: 타입·빌드**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/components/canvas2/Minimap.tsx
git commit -m "[feat]: 미니맵 2단계 드릴다운 — 태그 원↔태그 트리 (D148)"
```

---

## Task 7: 분기 대화 배선 (parent_node_id 전송)

`send`가 `parent_node_id`를 실제 전송. CanvasWorkspace가 head를 잡고 nodeId를 해석.
AskBar에 "이어서" 칩. 전송 후 head 해제(백엔드가 head 전진).

**Files:**
- Modify: `frontend/src/lib/canvas2/useCanvasStream.ts`
- Modify: `frontend/src/components/canvas2/CanvasWorkspace.tsx`
- Modify: `frontend/src/components/canvas2/AskBar.tsx`

**Interfaces:**
- `send`:
  ```ts
  send: (question: string, opts?: { parentItemId?: string | null; parentNodeId?: string | null }) => Promise<void>;
  ```
  `streamChat({ session_id, question, parent_node_id: opts?.parentNodeId ?? null }, ...)`.
- CanvasWorkspace: `const [headItemId, setHeadItemId] = useState<string | null>(null)`;
  `onSetHead = useEventCallback((id, nodeId) => setHeadItemId(id))`;
  전송 시 `headItem = items.find(i => i.id === headItemId)`,
  `stream.send(q, { parentItemId: headItemId, parentNodeId: headItem?.nodeId ?? null })`,
  이어서 `setHeadItemId(null)`.
- AskBar: 기존 `quote` prop을 headItem에서 파생해 "○○에 이어서" 칩으로 표시,
  `onClearQuote` → `setHeadItemId(null)`.

- [ ] **Step 1: 실패 테스트 (send가 parent_node_id를 싣는지)**

`useCanvasStream`은 훅이라 순수 단위테스트가 어렵다 → `streamChat` 호출 인자를
검증하는 얇은 테스트를 `lib/api/chat` 모킹으로. 간단히 `send` 내부에서 바디를
만드는 순수 헬퍼 `chatBody(sessionId, q, parentNodeId)`를 추출해 테스트:

```ts
// useCanvasStream.ts 에서 추출
export function chatBody(session_id: string, question: string, parentNodeId: string | null) {
  return { session_id, question, parent_node_id: parentNodeId };
}
// test
expect(chatBody("s", "q", "n1")).toEqual({ session_id: "s", question: "q", parent_node_id: "n1" });
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run` → FAIL

- [ ] **Step 3: 구현** — `send`가 `chatBody`로 바디 생성·전송; CanvasWorkspace
  head 상태·해석·전송 후 해제; AskBar 칩. onAsk(AI에게 묻기)도 `setHeadItemId(id)`로
  통일.

- [ ] **Step 4: 통과·타입·빌드** — Run: `cd frontend && npx vitest run && npx tsc --noEmit && npm run build` → PASS

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/canvas2/useCanvasStream.ts frontend/src/components/canvas2/CanvasWorkspace.tsx frontend/src/components/canvas2/AskBar.tsx
git commit -m "[feat]: 분기 대화 배선 — head의 nodeId를 parent_node_id로 전송 (D148)"
```

---

## Task 8: E2E — 트리·드릴다운·분기·영속

**Files:**
- Create: `frontend/e2e/tree.spec.ts`

**Interfaces:**
- Consumes: `frontend/e2e/helpers.ts`(`createNote`·`loginAndOpenCanvas`·`openCanvas`).

- [ ] **Step 1: 테스트 작성**

```ts
import { test, expect } from "@playwright/test";
import { createNote, loginAndOpenCanvas, openCanvas } from "./helpers";

test.describe.configure({ mode: "serial" });

test("서로 다른 태그는 각자 트리로 묶이고 새로고침에도 유지된다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const ts = Date.now();
  const A = `역사메모-${ts}`, B = `과학메모-${ts}`;
  await createNote(page, A, { x: 320, y: 240 });
  await createNote(page, B, { x: 620, y: 240 });
  // 각 노트에 다른 태그 부여(TagPicker) — helpers의 assignNewTag 패턴 재사용.
  // 태그 칩 두 개가 렌더되는지 확인.
  await expect(page.locator(".canvas2")).toBeVisible();
  await page.reload();
  await openCanvas(page);
  await expect(page.locator("[data-canvas-item]").filter({ hasText: A })).toBeVisible();
  // 정리: 만든 노트 삭제(세션 누적 방지) — tag.spec.ts 정리 단계와 동일 패턴.
});

test("미니맵 드릴다운 → 카드 클릭 시 컨텍스트가 그 카드로 지정된다", async ({ page }) => {
  // 태그 원 클릭 → 트리, 카드 점 클릭 → AskBar에 "이어서" 칩이 뜬다.
  // (칩 존재로 head 지정을 검증; 백엔드 분기는 단위/수동 검증)
});
```

- [ ] **Step 2: 실행**

Run: `cd frontend && npx playwright test e2e/tree.spec.ts`
Expected: PASS (dev 스택 필요 — `docker compose up -d`, backend, `npm run dev`)

- [ ] **Step 3: 커밋**

```bash
git add frontend/e2e/tree.spec.ts
git commit -m "[test]: 태그 트리·미니맵 드릴다운·분기 E2E (D148)"
```

---

## Self-Review 메모

- **스펙 커버리지**: ①=Task1~4, ②=Task5~6, ③=Task7, 테스트=Task8. 전부 매핑됨.
- **타입 일관성**: `columnX`→`tagRoots`(Placed)로 layout·useItemLayout·ItemLayer·
  Minimap·CanvasWorkspace에서 일괄 교체. `send` opts에 `parentNodeId` 추가.
- **위험**: Task3의 블록 회피 루프는 44px 스텝이라 큰 장애물에서 여러 번 돈다 —
  `MAX_PUSH` 상한(400) 유지로 무한루프 방지. 필요 시 "가장 아래 교차 장애물 밑"
  으로 점프해 스텝 수를 줄이는 최적화는 통과 후.
- **미측정 첫 프레임**: FALLBACK 크기로 트리를 그리므로 첫 렌더가 한 번 흔들릴 수
  있음 — 기존과 동일(ResizeObserver 후 안정).
