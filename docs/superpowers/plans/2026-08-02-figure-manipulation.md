# 교과서 도판 조작 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ReAct로 뜬 교과서 도판(`kind='figure'`)을 글 상자(TextItem)와 동등하게 선택·이동·리사이즈(비율 고정)·삭제할 수 있게 하고, 조작 결과가 새로고침 후에도 세션에 유지되게 한다.

**Architecture:** 드래그·선택·settle 로직을 TextItem에서 공유 훅 `useItemDrag`로 뽑아 TextItem·FigureItem이 함께 쓴다. `ResizeHandles`에 선택적 `aspect`를 더해 비율 고정을 지원한다. 위치·크기 영속은 새 로직 없이 기존 `pinned=true` + `x/y`/`data.size` 저장 경로를 그대로 탄다. 백엔드 변경 없음.

**Tech Stack:** Next.js(App Router) · React(+React Compiler eslint) · TypeScript · vitest · Tailwind CSS 변수 토큰

## Global Constraints

- 주석·커밋 메시지는 **한국어**, 제약·근거 위주. 커밋 프리픽스 `[feat]:`/`[fix]:`/`[docs]:`/`[tune]:`/`[chore]:`.
- 설계 결정은 D-번호로 코드 주석에 남긴다. 이 작업은 **D147**로 표기한다.
- **eslint에 React Compiler 규칙이 켜져 있다.** 렌더 중 ref 쓰기·이펙트 내 동기 setState는 에러다. 억제하지 말고 구조로 푼다.
- 프론트 테스트: `cd frontend && npm test` (vitest, `vitest run`). 대상은 `lib/canvas2`의 순수 함수.
- 타입/빌드 스모크: `cd frontend && npx tsc --noEmit && npm run build`. **dev 서버를 띄운 채 build 금지**(.next 덮어씀).
- **D87 불변식**: signed URL은 영속 금지. 도판 `data`를 서버에 저장할 때 `figure.url`은 반드시 빈 문자열이어야 한다.
- **좌표 규약**: `pinned=false`면 배치 엔진이 자리를 정하고, `pinned=true`면 저장된 `x/y`를 그대로 쓴다(영속의 근간).
- **거리/좌표는 world 단위**, 화면 px은 `zoom`으로 나눠 환산한다.

---

## 파일 구조

- **생성** `frontend/src/lib/canvas2/useItemDrag.ts` — 아이템 드래그·선택·settle 공유 훅 + `peerEls`.
- **생성** `frontend/src/lib/canvas2/useItemDrag.test.ts` — `peerEls` 단위 테스트.
- **생성** `frontend/src/lib/canvas2/figureData.ts` — `figureDataForSave` (D87 url 제거) 순수 헬퍼.
- **생성** `frontend/src/lib/canvas2/figureData.test.ts` — `figureDataForSave` 단위 테스트.
- **수정** `frontend/src/components/canvas2/ResizeHandles.tsx` — 순수 `requestedSize` 추출 + 선택적 `aspect` prop.
- **생성** `frontend/src/components/canvas2/ResizeHandles.test.ts` — `requestedSize` 비율 계산 테스트.
- **수정** `frontend/src/components/canvas2/TextItem.tsx` — 드래그 로직을 `useItemDrag`로 대체.
- **수정** `frontend/src/components/canvas2/FigureItem.tsx` — 드래그·선택·리사이즈·삭제·더블클릭 라이트박스 배선.
- **수정** `frontend/src/components/canvas2/ItemLayer.tsx` — FigureItem에 핸들러·selected·zoom 전달.
- **수정** `frontend/src/lib/api/canvas.ts` — `patchItem`이 저장 직전 `figureDataForSave`로 url 제거.

---

## Task 1: ResizeHandles 비율 고정 (`aspect`)

**Files:**
- Modify: `frontend/src/components/canvas2/ResizeHandles.tsx`
- Test: `frontend/src/components/canvas2/ResizeHandles.test.ts` (create)

**Interfaces:**
- Produces:
  - `export interface SizeReq { w: number; h: number }`
  - `export function requestedSize(dir: ResizeDir, mx: number, my: number, start: SizeReq, aspect?: number): SizeReq` — 마우스 이동량(world px)으로 요청 크기를 계산. `aspect`(= w/h)가 있으면 비율을 유지한다(클램프 없음, 순수).
  - `ResizeHandles` props에 `aspect?: number` 추가. 없으면 현행 자유 w/h(TextItem 무변경).

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/components/canvas2/ResizeHandles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { requestedSize } from "./ResizeHandles";

const start = { w: 300, h: 200 }; // aspect 1.5

describe("requestedSize — 자유 크기(aspect 없음)", () => {
  it("동쪽 손잡이는 폭만 늘린다", () => {
    expect(requestedSize("e", 40, 0, start)).toEqual({ w: 340, h: 200 });
  });
  it("서쪽 손잡이는 폭을 반대로 바꾼다", () => {
    expect(requestedSize("w", 40, 0, start)).toEqual({ w: 260, h: 200 });
  });
  it("남쪽 손잡이는 높이만 늘린다", () => {
    expect(requestedSize("s", 0, 30, start)).toEqual({ w: 300, h: 230 });
  });
});

describe("requestedSize — 비율 고정(aspect=1.5)", () => {
  it("동쪽으로 늘려도 높이가 비율을 따른다", () => {
    const r = requestedSize("e", 60, 0, start, 1.5);
    expect(r.w).toBe(360);
    expect(r.h).toBeCloseTo(240, 5); // 360 / 1.5
  });
  it("남쪽(세로 손잡이)으로 늘리면 폭이 비율을 따른다", () => {
    const r = requestedSize("s", 0, 40, start, 1.5);
    expect(r.h).toBe(240);
    expect(r.w).toBeCloseTo(360, 5); // 240 * 1.5
  });
  it("대각(se) 손잡이는 폭을 몰이축으로 삼아 비율을 지킨다", () => {
    const r = requestedSize("se", 60, 5, start, 1.5);
    expect(r.w).toBe(360);
    expect(r.h).toBeCloseTo(240, 5);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/components/canvas2/ResizeHandles.test.ts`
Expected: FAIL — `requestedSize` is not exported.

- [ ] **Step 3: `requestedSize` 추출 + `aspect` prop 추가**

`ResizeHandles.tsx` 상단(컴포넌트 밖)에 순수 함수를 추가한다. 파일 헤더 docstring에 D147 한 줄을 덧붙인다("도판은 비율 고정 — aspect로 다른 축을 몬다").

```ts
export interface SizeReq {
  w: number;
  h: number;
}

/**
 * 손잡이 방향과 마우스 이동량(world)으로 요청 크기를 낸다 (순수, 클램프 전).
 *
 * `aspect`(= w/h)가 있으면 비율을 지킨다 (D147, 도판). 가로가 걸린 손잡이는
 * 폭을 몰이축으로 삼아 높이를 유도하고, 세로만 걸린 손잡이는 그 반대다 —
 * 대각 손잡이도 폭이 몬다. 이미지가 찌그러지지 않게 한다.
 */
export function requestedSize(
  dir: ResizeDir,
  mx: number,
  my: number,
  start: SizeReq,
  aspect?: number,
): SizeReq {
  let w = start.w;
  let h = start.h;
  if (dir.includes("e")) w = start.w + mx;
  if (dir.includes("w")) w = start.w - mx;
  if (dir.includes("s")) h = start.h + my;
  if (dir.includes("n")) h = start.h - my;
  if (aspect) {
    const horizontal = dir.includes("e") || dir.includes("w");
    if (horizontal) h = w / aspect; // 폭이 몬다(가로·대각 손잡이)
    else w = h * aspect; // 세로 손잡이만
  }
  return { w, h };
}
```

`Props`에 `aspect?: number`를 추가하고, 컴포넌트 시그니처 구조분해에 `aspect`를 넣는다:

```ts
interface Props {
  zoom: number;
  color: string;
  /** 있으면 비율 고정(= w/h). 도판이 이미지 자연 비율을 준다 (D147). */
  aspect?: number;
  getEl: () => HTMLElement | null;
  onCommit: (next: ResizeCommit) => void;
  onReset: () => void;
}

export function ResizeHandles({ zoom, color, aspect, getEl, onCommit, onReset }: Props) {
```

`onMove`의 크기 계산부를 `requestedSize`로 갈아 끼운다. `aspect`가 있으면
**높이도 고정**(minHeight가 아니라 height)으로 세팅해 이미지 상자가 정확히
그 크기가 되게 한다. 클램프 후 비율을 다시 맞춘다:

```ts
  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      const el = getEl();
      if (!d || !el) return;
      const mx = (e.clientX - d.sx) / zoom;
      const my = (e.clientY - d.sy) / zoom;

      const req = requestedSize(d.dir, mx, my, { w: d.w, h: d.h }, aspect);
      let w = Math.max(ITEM_MIN_W, req.w);
      let h = Math.max(MIN_H, req.h);
      if (aspect) {
        // 클램프가 비율을 깨지 않게 폭을 몰이축으로 다시 맞춘다.
        h = w / aspect;
        if (h < MIN_H) {
          h = MIN_H;
          w = h * aspect;
        }
        el.style.width = `${w}px`;
        el.style.height = `${h}px`; // 도판은 고정 높이
      } else {
        el.style.width = `${w}px`;
        el.style.minHeight = `${h}px`; // 글은 최소 높이
      }

      const realW = el.offsetWidth;
      const realH = el.offsetHeight;
      d.dx = d.dir.includes("w") ? d.w - realW : 0;
      d.dy = d.dir.includes("n") ? d.h - realH : 0;
      el.style.transform = d.dx || d.dy ? `translate(${d.dx}px, ${d.dy}px)` : "";
    },
    [getEl, zoom, aspect],
  );
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/components/canvas2/ResizeHandles.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 타입 확인**

Run: `cd frontend && npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/components/canvas2/ResizeHandles.tsx frontend/src/components/canvas2/ResizeHandles.test.ts
git commit -m "[feat]: 리사이즈 손잡이에 비율 고정(aspect) 추가 (D147)"
```

---

## Task 2: `useItemDrag` 공유 훅 추출

TextItem의 드래그·선택·settle 로직을 그대로 뽑아 훅으로 만든다. **이 태스크에서는 훅만 만들고 아무도 쓰지 않는다** — TextItem 리팩터는 Task 3, FigureItem 배선은 Task 4다.

**Files:**
- Create: `frontend/src/lib/canvas2/useItemDrag.ts`
- Test: `frontend/src/lib/canvas2/useItemDrag.test.ts`

**Interfaces:**
- Produces:
  - `export function peerEls(group: boolean, self: HTMLElement | null): HTMLElement[]`
  - `export interface UseItemDragArgs { id: string; x: number; y: number; zoom: number; selected: boolean; enabled: boolean; rootRef: React.RefObject<HTMLElement | null>; onSelect: (id: string | null, additive?: boolean) => void; onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void; }`
  - `export interface UseItemDragResult { dragging: boolean; settle: () => void; handlers: { onPointerDown; onPointerMove; onPointerUp; onPointerCancel } }` (모두 `(e: React.PointerEvent) => void`)
  - `export function useItemDrag(args: UseItemDragArgs): UseItemDragResult`

- [ ] **Step 1: 실패하는 테스트 작성 (`peerEls`)**

`frontend/src/lib/canvas2/useItemDrag.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { peerEls } from "./useItemDrag";

afterEach(() => {
  document.body.innerHTML = "";
});

function addItem(id: string, selected: boolean): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-canvas-item", id);
  if (selected) el.setAttribute("data-selected", "1");
  document.body.appendChild(el);
  return el;
}

describe("peerEls", () => {
  it("group=false면 자기 자신만 반환한다", () => {
    const self = addItem("a", true);
    addItem("b", true);
    expect(peerEls(false, self)).toEqual([self]);
  });

  it("group=true면 선택된 아이템 전부를 모으고 자신을 포함한다", () => {
    const a = addItem("a", true);
    const b = addItem("b", true);
    addItem("c", false); // 선택 안 됨 — 제외
    const out = peerEls(true, a);
    expect(out).toContain(a);
    expect(out).toContain(b);
    expect(out).toHaveLength(2);
  });

  it("self가 선택 집합에 이미 있으면 중복으로 넣지 않는다", () => {
    const a = addItem("a", true);
    addItem("b", true);
    const out = peerEls(true, a);
    expect(out.filter((el) => el === a)).toHaveLength(1);
  });

  it("self가 null이어도 던지지 않는다", () => {
    addItem("a", true);
    expect(peerEls(true, null)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/lib/canvas2/useItemDrag.test.ts`
Expected: FAIL — cannot find module `./useItemDrag`.

- [ ] **Step 3: 훅 작성**

`frontend/src/lib/canvas2/useItemDrag.ts` 전체 (TextItem의 로직을 그대로 이식, 주석·상수 보존):

```ts
"use client";

/**
 * 아이템 드래그·선택 공유 훅 (D147).
 *
 * TextItem에 있던 드래그·선택·settle 로직을 뽑았다 — 글(TextItem)과
 * 도판(FigureItem)이 **같은 코드로** 움직이게 하기 위해서다. 복제하면
 * 시간이 지나며 둘이 어긋난다(CLAUDE.md의 "넷째 파싱을 만들면 어긋난다"와
 * 같은 정신). 로직 자체는 TextItem에서 실측으로 다듬어진 것이라 형태를
 * 그대로 보존한다.
 *
 * - 드래그 중에는 **React를 거치지 않고** DOM transform으로 움직인다.
 * - 함께 선택된 아이템(`[data-selected="1"]`)을 같은 양만큼 민다.
 * - 연결선은 `dragBus`로 따라간다.
 * - 좌표가 도착한 프레임에 transform을 걷어낸다(settle).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { clearDragOffsets, setDragOffsets } from "./dragBus";

/** 드래그로 인정하는 최소 이동(화면 px). 이보다 작으면 클릭이다. */
const DRAG_THRESHOLD = 4;
/** 위치 커밋이 끝내 안 올 때 transform을 걷어내는 안전망(ms). */
const DROP_FALLBACK_MS = 300;

/**
 * 함께 끌 요소들. **캐시하지 않고 그때그때 조회한다.**
 *
 * ref 안에 배열로 담아 두면 React Compiler가 막는다(immutability). 속성
 * 선택자 조회는 마이크로초 단위라 매 프레임 불러도 괜찮다.
 */
export function peerEls(group: boolean, self: HTMLElement | null): HTMLElement[] {
  const out = group
    ? Array.from(
        document.querySelectorAll<HTMLElement>('[data-canvas-item][data-selected="1"]'),
      )
    : [];
  if (self && !out.includes(self)) out.push(self);
  return out;
}

export interface UseItemDragArgs {
  id: string;
  x: number;
  y: number;
  /** 현재 줌. 화면 이동량을 world로 바꾼다. */
  zoom: number;
  selected: boolean;
  /** 드래그를 받을 수 있나 (TextItem은 편집 중이면 false). */
  enabled: boolean;
  /** 아이템 루트. 끄는 동안 이 요소의 transform을 직접 고친다. */
  rootRef: React.RefObject<HTMLElement | null>;
  onSelect: (id: string | null, additive?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void;
}

export interface UseItemDragResult {
  dragging: boolean;
  /** 좌표 도착 프레임에 호출해 남은 transform을 걷어낸다. */
  settle: () => void;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
}

export function useItemDrag({
  id,
  x,
  y,
  zoom,
  selected,
  enabled,
  rootRef,
  onSelect,
  onDragEnd,
}: UseItemDragArgs): UseItemDragResult {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    sx: number;
    sy: number;
    moved: boolean;
    group: boolean;
    wasSelected: boolean;
    additive: boolean;
  } | null>(null);

  const settle = useCallback(() => {
    const el = rootRef.current;
    if (!el || dragRef.current || !el.style.transform) return;
    const prev = el.style.transition;
    el.style.transition = "none";
    el.style.transform = "";
    void el.offsetHeight; // 강제 리플로우 — transition:none을 이 프레임에 확정
    el.style.transition = prev;
    setDragging(false);
  }, [rootRef]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      if (e.button !== 0) return; // 왼쪽 버튼만 드래그. 중버튼은 팬.
      const t = e.target as HTMLElement;
      if (t.closest("[data-no-pan]")) return; // 버튼·메뉴·손잡이는 자기 일을 한다
      e.stopPropagation(); // Excalidraw가 선택 상자를 그리지 않게

      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (additive) onSelect(id, true);
      else if (!selected) onSelect(id, false);

      dragRef.current = {
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        group: selected,
        wasSelected: selected,
        additive,
      };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // 활성 포인터가 아니면 던진다 — 캡처는 편의일 뿐이다.
      }
    },
    [enabled, id, onSelect, selected],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        setDragging(true);
      }
      const wx = dx / zoom;
      const wy = dy / zoom;
      const shift = `translate(${wx}px, ${wy}px)`;
      const peers = peerEls(d.group, rootRef.current);
      for (const el of peers) {
        el.style.transition = "none";
        el.style.transform = shift;
      }
      setDragOffsets(
        peers.map((el) => el.getAttribute("data-canvas-item") ?? "").filter(Boolean),
        wx,
        wy,
      );
    },
    [zoom, rootRef],
  );

  const finishDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;

      const peers = peerEls(d.group, rootRef.current);
      clearDragOffsets();
      if (!d.moved) {
        if (!d.additive && d.wasSelected) onSelect(id, false);
        setDragging(false);
        for (const el of peers) el.style.transition = "";
        return;
      }
      const dx = (e.clientX - d.sx) / zoom;
      const dy = (e.clientY - d.sy) / zoom;
      for (const el of peers) el.style.transition = "";
      onDragEnd(id, x + dx, y + dy, dx, dy);
      window.setTimeout(settle, DROP_FALLBACK_MS);
    },
    [id, onDragEnd, onSelect, settle, x, y, zoom, rootRef],
  );

  useEffect(
    () => () => {
      dragRef.current = null;
    },
    [],
  );

  return {
    dragging,
    settle,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishDrag,
      onPointerCancel: finishDrag,
    },
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/lib/canvas2/useItemDrag.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 타입/린트 확인**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/lib/canvas2/useItemDrag.ts`
Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/lib/canvas2/useItemDrag.ts frontend/src/lib/canvas2/useItemDrag.test.ts
git commit -m "[feat]: 아이템 드래그·선택 로직을 공유 훅 useItemDrag로 추출 (D147)"
```

---

## Task 3: TextItem을 `useItemDrag`로 리팩터

TextItem의 드래그 로직을 훅 호출로 바꾼다. **동작 보존이 목표** — 렌더·편집·인출·hover·리사이즈는 건드리지 않는다.

**Files:**
- Modify: `frontend/src/components/canvas2/TextItem.tsx`

**Interfaces:**
- Consumes: `useItemDrag`, `peerEls` (Task 2).

- [ ] **Step 1: import 교체**

TextItem.tsx 상단에서 `dragBus` import와 로컬 `peerEls`·상수를 제거하고 훅을 들여온다.

제거:
```ts
import { clearDragOffsets, setDragOffsets } from "@/lib/canvas2/dragBus";
```
그리고 파일 안의 `const DRAG_THRESHOLD = 4;`, `const DROP_FALLBACK_MS = 300;`, `function peerEls(...) {...}` 정의 전체.

추가:
```ts
import { useItemDrag } from "@/lib/canvas2/useItemDrag";
```

`DROP_FALLBACK_MS`는 리사이즈 커밋 뒤 `settle` 안전망 타이머(`window.setTimeout(settle, DROP_FALLBACK_MS)`)에서도 쓰인다. 훅이 export하지 않으므로 TextItem에 **로컬 상수로 남긴다**:
```ts
/** 리사이즈 커밋 뒤 남은 transform을 걷어내는 안전망(ms). */
const DROP_FALLBACK_MS = 300;
```

- [ ] **Step 2: 드래그 상태·핸들러를 훅으로 대체**

`TextItemImpl` 안에서 다음을 제거한다:
- `const [dragging, setDragging] = useState(false);`
- `dragRef` 정의
- `settle` 정의 (`useCallback`)
- `onPointerDown` 정의
- `onPointerMove` 정의
- `finishDrag` 정의
- 언마운트 정리 이펙트 `useEffect(() => () => { dragRef.current = null; }, []);`

그 자리에 훅 호출을 넣는다 (`rootRef`·`setNode`는 그대로 둔다):

```ts
  const { dragging, settle, handlers: dragHandlers } = useItemDrag({
    id: item.id,
    x,
    y,
    zoom,
    selected,
    enabled: !editing, // 편집 중에는 드래그하지 않는다
    rootRef,
    onSelect,
    onDragEnd,
  });
```

- [ ] **Step 3: 루트 요소의 포인터 핸들러 배선 교체**

루트 `<div ref={setNode} ...>`의 포인터 속성을 훅 핸들러로 바꾼다:

```tsx
      onPointerDown={dragHandlers.onPointerDown}
      onPointerMove={dragHandlers.onPointerMove}
      onPointerUp={dragHandlers.onPointerUp}
      onPointerCancel={dragHandlers.onPointerCancel}
```

`settle`을 호출하는 `useLayoutEffect(() => { settle(); }, [x, y, settle]);`는 그대로 둔다(훅이 `settle`을 준다). `ResizeHandles.onCommit` 안의 `window.setTimeout(settle, DROP_FALLBACK_MS)`도 그대로 둔다.

- [ ] **Step 4: 기존 테스트·타입·린트 통과 확인**

Run: `cd frontend && npm test && npx tsc --noEmit && npx eslint src/components/canvas2/TextItem.tsx`
Expected: 전부 PASS, 오류 없음. (배치 무겹침 등 기존 테스트가 회귀 없음을 보장)

- [ ] **Step 5: 수동 동등성 검증 (dev 서버)**

`cd frontend && npm run dev` 로 띄우고 세션을 연 뒤, 리팩터 **전과 같은지** 확인한다:
- 글 상자 하나 드래그 → 옮겨지고, 놓으면 그 자리에 남는다(깜박임 없음).
- Shift로 둘 이상 선택 후 하나를 끌면 함께 움직인다.
- 부모-자식(연결선) 있는 글을 끌면 연결선이 따라온다.
- 그냥 클릭은 선택, 더블클릭은 편집.
- 편집 중에는 드래그되지 않고 글자 선택이 된다.

문제가 있으면 이 태스크를 고친다(Task 4로 넘어가지 않는다).

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/components/canvas2/TextItem.tsx
git commit -m "[feat]: TextItem이 공유 훅 useItemDrag를 쓰도록 리팩터 (D147)"
```

---

## Task 4: FigureItem 드래그·선택·이동 영속 + ItemLayer 배선

도판을 끌어 옮기고 선택할 수 있게 한다. 옮긴 자리는 `pinned=true` + `x/y`로 저장돼 새로고침 후 유지된다(기존 경로 재사용, 새 저장 로직 없음).

**Files:**
- Modify: `frontend/src/components/canvas2/FigureItem.tsx`
- Modify: `frontend/src/components/canvas2/ItemLayer.tsx`

**Interfaces:**
- Consumes: `useItemDrag` (Task 2), `CanvasWorkspace`의 기존 `handlers`(`onSelect`·`onDragEnd`·`onDelete`·`onResize`·`onResetSize`).
- Produces: `FigureItem` props 확장 — `selected: boolean`, `zoom: number`, `onSelect`, `onDragEnd`, `onDelete`, `onResize`, `onResetSize`.

- [ ] **Step 1: ItemLayer가 FigureItem에 핸들러를 넘기게 한다**

`ItemLayer.tsx`의 figure 분기를 확장한다:

```tsx
        if (item.kind === "figure") {
          return (
            <FigureItem
              key={item.id}
              item={item}
              x={p.x}
              y={p.y}
              zoom={zoom}
              selected={selectedIds.has(item.id)}
              measure={measure}
              onSelect={handlers.onSelect}
              onDragEnd={handlers.onDragEnd}
              onDelete={handlers.onDelete}
              onResize={handlers.onResize}
              onResetSize={handlers.onResetSize}
            />
          );
        }
```

- [ ] **Step 2: FigureItem props 확장**

`FigureItem.tsx`의 `Props`를 바꾼다(기존 `item/x/y/measure` 유지 + 추가):

```ts
import type { ResizeCommit } from "./ResizeHandles";

interface Props {
  item: CanvasItem;
  x: number;
  y: number;
  zoom: number;
  selected: boolean;
  measure: (id: string, el: HTMLElement | null) => void;
  onSelect: (id: string | null, additive?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void;
  onDelete: (id: string) => void;
  onResize: (id: string, next: ResizeCommit) => void;
  onResetSize: (id: string) => void;
}
```

- [ ] **Step 3: 드래그 훅 + rootRef 배선**

`FigureItem` 함수 안, 기존 상태 선언부 근처에 추가한다:

```ts
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useItemDrag } from "@/lib/canvas2/useItemDrag";
```

```ts
  const rootRef = useRef<HTMLDivElement>(null);
  const setNode = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      measure(item.id, el);
    },
    [measure, item.id],
  );

  const { dragging, settle, handlers: dragHandlers } = useItemDrag({
    id: item.id,
    x,
    y,
    zoom,
    selected,
    enabled: true, // 도판엔 편집 모드가 없다 — 항상 드래그 가능
    rootRef,
    onSelect,
    onDragEnd,
  });

  // 좌표가 도착한 프레임에 남은 transform을 걷어낸다(TextItem과 동형).
  useLayoutEffect(() => {
    settle();
  }, [x, y, settle]);
```

- [ ] **Step 4: 루트 div를 드래그·선택 가능한 컨테이너로**

기존 루트 `<div ref={(el) => measure(item.id, el)} ...>`를 아래로 교체한다. `data-selected`(그룹 드래그 전제)·포인터 핸들러·키보드·전이·커서를 붙인다. 폭은 `size?.w ?? ITEM_W`.

```tsx
  const size = item.data.size;

  return (
    <>
      <div
        ref={setNode}
        data-canvas-item={item.id}
        data-selected={selected ? "1" : undefined}
        className="absolute"
        style={{
          left: x,
          top: y,
          width: size?.w ?? ITEM_W,
          height: size?.h, // 없으면 내용(이미지)이 높이를 정한다
          pointerEvents: "var(--c2-item-events)" as React.CSSProperties["pointerEvents"],
          zIndex: selected ? 12 : dragging ? 11 : 10,
          cursor: dragging ? "grabbing" : "grab",
          userSelect: "none",
          transition: dragging
            ? "none"
            : "left .28s cubic-bezier(.22,.9,.24,1), top .28s cubic-bezier(.22,.9,.24,1)",
        }}
        onPointerDown={dragHandlers.onPointerDown}
        onPointerMove={dragHandlers.onPointerMove}
        onPointerUp={dragHandlers.onPointerUp}
        onPointerCancel={dragHandlers.onPointerCancel}
        tabIndex={0}
        role="group"
        aria-label={fig.caption || "교과서 도판"}
        onFocus={(e) => {
          if (!e.currentTarget.matches(":focus-visible")) return;
          onSelect(item.id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            onDelete(item.id);
          } else if (e.key === "Escape") {
            onSelect(null);
            (e.currentTarget as HTMLElement).blur();
          }
        }}
      >
```

좌측 괘선 `<div aria-hidden ... background: var(--c-live) ...>`는 그대로 둔다.

- [ ] **Step 5: 이미지 블록 — data-no-pan 제거, 클릭 대신 더블클릭 라이트박스**

기존 `<button ... data-no-pan onClick={() => url && setOpen(true)} ...>`를 드래그를 막지 않는 컨테이너로 바꾼다. **`data-no-pan`을 제거**(도판 몸통에서 끌 수 있어야 한다)하고, 라이트박스는 **더블클릭**으로 연다(TextItem이 더블클릭으로 편집을 여는 것과 동형 — 단일 클릭은 선택). `<button>`을 `<div>`로 바꿔 드래그 중 클릭 활성화를 피한다:

```tsx
        <div
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (url) setOpen(true);
          }}
          className="block w-full overflow-hidden rounded-lg border text-left"
          style={{ borderColor: "var(--c-rule)", background: "var(--c-raised)" }}
          title="더블클릭하면 크게 볼 수 있어요"
        >
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={fig.caption || "교과서 도판"}
              onError={refresh}
              draggable={false}
              className="pointer-events-none block w-full object-contain"
              style={{ background: "var(--c-sunk)", maxHeight: size ? undefined : "16rem" }}
            />
          ) : (
            <div
              className="flex h-40 items-center justify-center text-sm"
              style={{ background: "var(--c-sunk)", color: "var(--c-ink-faint)" }}
            >
              도판 불러오는 중…
            </div>
          )}
          <div className="px-3 py-2">
            <p className="line-clamp-2 text-[13px]" style={{ color: "var(--c-ink)" }}>
              {fig.caption || "설명 없음"}
            </p>
            <p className="label mt-1" style={{ color: "var(--c-ink-faint)", letterSpacing: 0 }}>
              교과서 {fig.page}쪽
            </p>
          </div>
        </div>
```

`draggable={false}` + `pointer-events-none`으로 이미지의 기본 드래그(ghost)와 이벤트 가로채기를 막아 루트 드래그가 온전히 동작하게 한다.

- [ ] **Step 6: 선택 테두리 표시**

루트 안, 이미지 블록 **앞에** 선택 강조 박스를 넣는다(흐름 밖 absolute — 크기에 영향 없음). 드래그 중에는 그림자만:

```tsx
        <div
          aria-hidden
          className="pointer-events-none absolute transition-opacity duration-150"
          style={{
            inset: "-6px",
            borderRadius: "var(--c-radius)",
            border: `${selected ? Math.max(1, 1.5 / zoom) : 1}px solid ${
              selected ? "var(--c-live)" : "transparent"
            }`,
            opacity: selected ? 1 : 0,
            boxShadow: dragging ? "var(--c-shadow-lg)" : "none",
          }}
        />
```

- [ ] **Step 7: 타입/린트/빌드 확인**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/components/canvas2/FigureItem.tsx src/components/canvas2/ItemLayer.tsx`
Expected: 오류 없음. (리사이즈·삭제 버튼은 Task 5·6에서 붙이므로 여기서는 `onResize`·`onResetSize`가 아직 미사용 경고가 날 수 있다 → Step 8에서 lint 억제 대신 Task 5에서 소비하므로, 이 태스크에서는 두 prop을 구조분해만 하고 사용하지 않으면 eslint `no-unused-vars`가 뜬다. 이를 피하려면 Step 2에서 `onResize`·`onResetSize`를 **구조분해하지 말고** Task 5에서 추가한다.)

> 실행 지침: Step 2의 Props 타입에는 `onResize`·`onResetSize`를 포함하되, 함수 구조분해(`function FigureItem({ ... })`)에서는 Task 5에서 쓸 때 추가한다. Task 4에서는 `onSelect`·`onDragEnd`·`onDelete`만 구조분해한다. ItemLayer(Step 1)는 다섯 핸들러를 모두 넘겨도 무방하다(전달만 하므로).

- [ ] **Step 8: 수동 검증 (dev 서버)**

세션에서 도판을 띄운 뒤:
- 도판 몸통을 끌면 옮겨진다. 놓으면 그 자리에 남는다.
- **새로고침 → 옮긴 자리에 그대로 있다** (핵심 수용 기준).
- 도판을 클릭하면 선택 테두리(오커)가 뜬다. 더블클릭하면 라이트박스가 열린다.
- 글 상자와 도판을 함께 올가미/Shift 선택 후 하나를 끌면 같이 움직인다.
- 도판을 선택하고 Delete를 누르면 사라진다(되돌리기 토스트 뜸).

- [ ] **Step 9: 커밋**

```bash
git add frontend/src/components/canvas2/FigureItem.tsx frontend/src/components/canvas2/ItemLayer.tsx
git commit -m "[feat]: 교과서 도판을 드래그로 옮기고 선택·영속 (D147)"
```

---

## Task 5: FigureItem 리사이즈(비율 고정) + D87 url 제거

도판을 여덟 손잡이로 비율 유지한 채 크기 조절하고, 크기(`data.size`)를 저장한다. 저장 시 `figure.url`을 비워 D87을 지킨다.

**Files:**
- Create: `frontend/src/lib/canvas2/figureData.ts`
- Test: `frontend/src/lib/canvas2/figureData.test.ts`
- Modify: `frontend/src/lib/api/canvas.ts`
- Modify: `frontend/src/components/canvas2/FigureItem.tsx`

**Interfaces:**
- Produces: `export function figureDataForSave(data: ItemData): ItemData` — `data.figure`가 있으면 `figure.url`을 `""`로 비운 **새 객체**를 반환(원본 불변). 없으면 원본 그대로.
- Consumes: `ResizeHandles`의 `aspect` prop (Task 1), `onResize`·`onResetSize` (Task 4의 Props).

- [ ] **Step 1: 실패하는 테스트 작성 (`figureDataForSave`)**

`frontend/src/lib/canvas2/figureData.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { figureDataForSave } from "./figureData";
import type { ItemData } from "./types";

describe("figureDataForSave — D87 url 제거", () => {
  it("figure.url을 빈 문자열로 비운다", () => {
    const data: ItemData = {
      figure: { figureId: "f1", fileId: "x", page: 3, caption: "c", url: "https://signed/abc" },
    };
    const out = figureDataForSave(data);
    expect(out.figure?.url).toBe("");
  });

  it("원본을 변형하지 않는다(불변)", () => {
    const data: ItemData = {
      figure: { figureId: "f1", fileId: "x", page: 3, caption: "c", url: "https://signed/abc" },
    };
    figureDataForSave(data);
    expect(data.figure?.url).toBe("https://signed/abc");
  });

  it("size 등 다른 필드는 보존한다", () => {
    const data: ItemData = {
      figure: { figureId: "f1", fileId: "x", page: 3, caption: "c", url: "u" },
      size: { w: 200, h: 140 },
    };
    const out = figureDataForSave(data);
    expect(out.size).toEqual({ w: 200, h: 140 });
  });

  it("figure가 없으면 원본을 그대로 돌려준다", () => {
    const data: ItemData = { size: { w: 100, h: 80 } };
    expect(figureDataForSave(data)).toBe(data);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/lib/canvas2/figureData.test.ts`
Expected: FAIL — cannot find module `./figureData`.

- [ ] **Step 3: `figureDataForSave` 작성**

`frontend/src/lib/canvas2/figureData.ts`:

```ts
/**
 * 도판 data를 서버에 저장 가능한 형태로 (D147).
 *
 * signed URL은 6시간 뒤 만료된다 — 영속하면 화석이 된다(D87). 리사이즈처럼
 * data를 통째로 PATCH할 때 살아 있는 url이 실려 나가지 않게, 저장 직전
 * figure.url을 비운다. 화면 표시는 메모리의 값이 계속 쓰므로 영향이 없다.
 *
 * 원본을 변형하지 않는다 — 낙관적 갱신이 쥔 로컬 data는 살아 있는 url을
 * 그대로 두어 이미지가 사라지지 않아야 한다.
 */
import type { ItemData } from "./types";

export function figureDataForSave(data: ItemData): ItemData {
  if (!data.figure) return data;
  return { ...data, figure: { ...data.figure, url: "" } };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/lib/canvas2/figureData.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: `patchItem`이 저장 직전 url을 비우게 한다**

`frontend/src/lib/api/canvas.ts`의 `patchItem`에서 fetch 직전에 도판 data를 정리한다. **네트워크 경계 한 곳**에서 막아, 어떤 호출부가 도판 data를 PATCH해도 D87이 지켜진다(낙관적 로컬 상태는 이 경로를 타지 않으므로 살아 있는 url을 유지).

상단 import에 추가:
```ts
import { figureDataForSave } from "@/lib/canvas2/figureData";
```

`patchItem` 본문에서 body 직렬화를 바꾼다:
```ts
  const wire =
    patch.data !== undefined ? { ...patch, data: figureDataForSave(patch.data) } : patch;
  const res = await ensureOk(
    await fetch(`${API_BASE}/canvas/items/${itemId}`, {
      method: "PATCH",
      headers: await authHeaders(true),
      body: JSON.stringify(wire),
    }),
  );
```

- [ ] **Step 6: FigureItem에 ResizeHandles + 자연 비율 배선**

`FigureItem.tsx` 함수 구조분해에 `onResize`·`onResetSize`를 추가한다(Task 4 Step 7 지침).

이미지 자연 비율을 확보한다(로드 후). 아직이면 렌더 상자 비율로 폴백:

```ts
import { ITEM_W } from "@/lib/canvas2/layout";
import { ResizeHandles } from "./ResizeHandles";
```

```ts
  /** 이미지 자연 비율(= w/h). 로드 전엔 null — 그동안은 렌더 상자 비율을 쓴다. */
  const [aspect, setAspect] = useState<number | null>(null);
```

`<img>`에 `onLoad`를 추가한다(기존 `onError={refresh}` 옆):
```tsx
              onLoad={(e) => {
                const el = e.currentTarget;
                if (el.naturalWidth && el.naturalHeight) {
                  setAspect(el.naturalWidth / el.naturalHeight);
                }
              }}
```

루트 안, 선택 시 손잡이를 그린다(드래그 중에는 숨김 — TextItem과 동형). `DROP_FALLBACK_MS` 로컬 상수를 FigureItem에도 둔다:

```ts
/** 리사이즈 커밋 뒤 남은 transform을 걷어내는 안전망(ms). */
const DROP_FALLBACK_MS = 300;
```

```tsx
        {selected && !dragging && (
          <ResizeHandles
            zoom={zoom}
            color="var(--c-live)"
            aspect={
              size ? size.w / size.h : aspect ?? undefined
            }
            getEl={() => rootRef.current}
            onCommit={(next) => {
              onResize(item.id, next);
              window.setTimeout(settle, DROP_FALLBACK_MS);
            }}
            onReset={() => onResetSize(item.id)}
          />
        )}
```

`CanvasWorkspace.onResize`는 이미 `data.size`를 저장하고 왼/위 손잡이면 `pinned=true`로 만든다(기존 코드, 변경 불필요). url 제거는 Step 5의 `patchItem`이 담당한다.

- [ ] **Step 7: 타입/린트/빌드 확인**

Run: `cd frontend && npm test && npx tsc --noEmit && npx eslint src/components/canvas2/FigureItem.tsx src/lib/api/canvas.ts`
Expected: 전부 PASS, 오류 없음.

- [ ] **Step 8: 수동 검증 (dev 서버)**

- 도판 선택 → 여덟 손잡이가 뜬다. 대각으로 끌면 **비율을 유지한 채** 커지고 작아진다(이미지가 찌그러지지 않는다).
- 변 손잡이(동/남)로 끌어도 비율이 유지된다.
- 손잡이 더블클릭 → 자동 크기로 되돌아간다.
- **새로고침 → 조절한 크기가 유지된다.**
- 백엔드 확인(선택): 저장된 도판 행의 `data.figure.url`이 빈 문자열이다(네트워크 탭 PATCH 페이로드 또는 DB).

- [ ] **Step 9: 커밋**

```bash
git add frontend/src/lib/canvas2/figureData.ts frontend/src/lib/canvas2/figureData.test.ts frontend/src/lib/api/canvas.ts frontend/src/components/canvas2/FigureItem.tsx
git commit -m "[feat]: 교과서 도판 비율 고정 리사이즈 + 저장 시 url 제거(D87) (D147)"
```

---

## Task 6: FigureItem 삭제 버튼

키보드 삭제는 Task 4에서 됐다. 여기서는 hover/선택 시 뜨는 **× 삭제 버튼**을 붙여 마우스만으로도 지울 수 있게 한다.

**Files:**
- Modify: `frontend/src/components/canvas2/FigureItem.tsx`

**Interfaces:**
- Consumes: `onDelete` (Task 4).

- [ ] **Step 1: hover 상태 추가**

`FigureItem` 함수 안에 추가:
```ts
  const [hover, setHover] = useState(false);
```
루트 div에 `onMouseEnter`·`onMouseLeave`를 붙인다(Task 4의 루트 div 속성에 추가):
```tsx
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
```

- [ ] **Step 2: 삭제 버튼 렌더**

루트 안(선택 테두리 뒤, 이미지 블록 앞 또는 뒤)에 우상단 × 버튼을 넣는다. hover 또는 selected일 때만 보이고, `data-no-pan`으로 드래그로 넘어가지 않게 한다:

```tsx
import { X } from "lucide-react"; // 이미 import되어 있음(라이트박스 닫기)
```

```tsx
        {(hover || selected) && (
          <button
            type="button"
            data-no-pan
            aria-label="도판 삭제"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(item.id);
            }}
            className="absolute -right-2 -top-2 z-20 flex h-7 w-7 items-center justify-center rounded-md border transition-colors"
            style={{
              background: "var(--c-raised)",
              borderColor: "var(--c-rule)",
              color: "var(--c-ink-soft)",
              boxShadow: "var(--c-shadow-sm)",
            }}
          >
            <X size={15} />
          </button>
        )}
```

- [ ] **Step 3: 타입/린트/빌드 확인**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/components/canvas2/FigureItem.tsx && npm run build`
Expected: 오류 없음, 빌드 성공.

- [ ] **Step 4: 수동 검증 (dev 서버)**

- 도판에 마우스를 올리면 우상단 × 버튼이 뜬다. 누르면 도판이 사라지고 되돌리기 토스트가 뜬다.
- × 버튼을 눌러도 드래그로 새지 않는다(제자리에서 삭제).
- 되돌리기 → 도판이 돌아온다.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/components/canvas2/FigureItem.tsx
git commit -m "[feat]: 교과서 도판 × 삭제 버튼 (D147)"
```

---

## Self-Review (계획 검증)

**Spec 커버리지**
- 이동 + 위치 영속 → Task 4 (드래그 → `pinned=true` + x/y, 새로고침 유지). ✔
- 리사이즈(비율 고정) + 영속 → Task 1(aspect 계산) + Task 5(FigureItem 배선, `data.size` 저장). ✔
- 삭제 → Task 4(키보드) + Task 6(× 버튼). ✔
- 선택(클릭·올가미·그룹) → Task 4(`useItemDrag`의 선택, `data-selected`, 테두리). 올가미는 기존 `handleMarquee`가 `items`(도판 포함)·`layout.sizes`로 이미 판정하며, 이제 FigureItem이 `selected`를 반영해 하이라이트된다. ✔
- 공유 훅(판단 1) → Task 2(추출) + Task 3(TextItem) + Task 4(FigureItem). ✔
- D87 url 영속 금지 → Task 5(`figureDataForSave` + `patchItem` 경계). ✔
- 비목표(피커·백엔드 변경) → 계획에 없음. ✔

**플레이스홀더 스캔** — TBD/TODO/"적절히 처리" 없음. 모든 코드 단계에 실제 코드. ✔

**타입 일관성**
- `requestedSize(dir, mx, my, start, aspect?)` — Task 1 정의, Task 1 onMove에서 소비. ✔
- `useItemDrag(args): { dragging, settle, handlers }` — Task 2 정의, Task 3·4에서 동일 시그니처로 소비. ✔
- `figureDataForSave(data): ItemData` — Task 5 정의·소비. ✔
- `ResizeCommit`(`{w,h,dx,dy}`) — 기존 타입, Task 4 Props·Task 5에서 소비. ✔
- FigureItem Props 확장(`selected/zoom/onSelect/onDragEnd/onDelete/onResize/onResetSize`) — Task 4에서 타입 선언, Task 4·5·6에서 소비. ✔

**주의(실행자에게)**: Task 4 Step 7의 미사용 prop 경고를 피하려면, 함수 구조분해는 태스크가 실제로 쓰는 시점에 추가한다(Task 4: onSelect/onDragEnd/onDelete, Task 5: onResize/onResetSize). Props **타입**에는 처음부터 전부 선언한다.
