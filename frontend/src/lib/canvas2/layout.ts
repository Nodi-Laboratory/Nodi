/**
 * 배치 엔진 (D123) — 태그 열(column) 배치.
 *
 * ## 왜 d3-force를 버렸나
 *
 * v1은 `forceManyBody(-500)` + `forceCollide(원형)` + 태그 앵커로 당기는
 * 커스텀 힘이었다. 넷이 문제였다:
 *
 *   1. 요구가 "정해진 알고리즘 + 순서적인 모습"인데 힘 시뮬레이션은 순서를
 *      보존하지 못한다.
 *   2. 요구가 "겹치면 안 된다"인데 원형 collide로는 **보장**할 수 없다 —
 *      수렴 전에 멈추면 겹친 채로 남는다(alphaMin 0.02로 일찍 멈춘다).
 *   3. 길이 제한을 풀면 높이 편차가 커진다. 420폭 사각형을 대각선 반경
 *      hypot(420,h)/2 원으로 밀어내니 세로로 과도하게 벌어졌다.
 *   4. 매 틱 positions Map을 새로 만들어 memo가 무력화되고 카드 전체가
 *      60fps로 리렌더됐다.
 *
 * ## 열 배치
 *
 * ```
 *   태그 A          태그 B          태그 C
 *   ┌────────┐     ┌────────┐     ┌────────┐
 *   │ seq 1  │     │ seq 2  │     │ seq 5  │
 *   └────────┘     └────────┘     └────────┘
 *   ┌────────┐     ┌────────┐
 *   │ seq 3  │     │ seq 6  │
 *   │        │     └────────┘
 *   └────────┘
 * ```
 *
 * - 태그마다 열 하나. 열 x는 **첫 등장 순서**로 정해지고 영구 불변(D90 계승).
 * - 열 안에서는 seq 오름차순으로 위→아래.
 * - 폭 고정, 높이는 실측(ResizeObserver).
 *
 * **무겹침이 알고리즘의 성질이지 수렴의 결과가 아니다.** 열끼리는 x가 겹치지
 * 않고, 열 안에서는 y를 누적하므로 원리적으로 겹칠 수 없다. 이게 핵심이다.
 *
 * ## 장애물
 *
 * pinned 아이템(학생이 옮긴 것)과 그림 요소는 **읽기만** 한다. 자동 배치되는
 * 아이템이 그것들과 겹치면 아래로 건너뛴다. y가 단조 증가하므로 반드시 끝난다.
 */

import { bottom, intersects, type Rect } from "./rect";
import { buildTrees, type TreeItem } from "./tree";

/**
 * 아이템 **최대** 폭. 한 줄에 한국어 30~34자 — 문단이 읽히는 폭이다.
 *
 * 예전에는 이게 고정 폭이었다. 그래서 "구름이 왜 하늘에 떠 있지?" 한 줄짜리
 * 메모도 460px를 차지했고, 글은 왼쪽 끝에 있는데 연결선은 460px 바깥에서
 * 출발했다 — 선의 끝점이 정작 글에서 멀리 떨어져 보이는 이유였다(사용자 지적).
 * 지금은 내용이 짧으면 그만큼만 차지하고, 이 값은 상한으로만 쓴다.
 */
export const ITEM_W = 560;
/** 아이템 최소 폭. 빈 메모가 0폭으로 찌그러지지 않게. */
export const ITEM_MIN_W = 132;
/**
 * 열 사이 간격.
 *
 * 72였다. 폭이 460인 글 옆에 72px 틈이면 **어느 열에 속하는지 눈으로 갈리지
 * 않는다** — 사용자 지시(2026-07-31: "서로 다른 태그들이 생성되는 간격을 넓게
 * 해서 구분되게")로 240으로 넓혔다.
 *
 * 부수 효과가 하나 더 있다. 개념 지도가 열 위치를 축소해 보여 주는데, 열이
 * 붙어 있으면 지도에서도 겹쳐 보인다. 간격을 벌리면 지도에서 태그가 서로
 * 떨어져 찍힌다 — 사용자가 "겹치는 부분이 많아 보기 힘들다"고 한 지점이다.
 *
 * 대가는 이동 거리다. 열이 늘수록 가로로 길어지므로 지도 클릭 이동과
 * "전체 보기"가 그만큼 더 중요해진다.
 */
export const COL_GAP = 460;
// 240이었다. 카드 폭이 460→560으로 커지면서 열 사이가 상대적으로 더 좁아
// 보였다("트리들이 너무 촘촘하게 붙어있다" — 사용자 지시 2026-08-03).
/**
 * 같은 열 안 세로 간격.
 *
 * 44였다. 카드가 커지고(ITEM_W 560) 연결선이 굵어지면서 44는 글과 글이
 * 서로 붙어 보였다 — 사용자 지시 2026-08-03: "노드들 사이의 공간을 좀 넓게".
 * 연결선이 지나갈 자리이기도 하다.
 */
export const ROW_GAP = 96;
/** 열의 시작 y. 태그 라벨이 위에 붙을 자리를 남긴다. */
export const COL_TOP = 0;
/** 자식(AI 응답)을 부모(메모) 옆에 둘 때의 가로 간격. */
export const CHILD_GAP = 88;
/**
 * 형제 서브트리 사이 간격 (D159).
 *
 * 카드 폭(560)에 비해 좁으면 가지가 갈라진 것이 안 보이고, 너무 넓으면 한
 * 트리가 화면을 벗어난다.
 */
export const SIB_GAP = 96;
/** 겹침 회피 루프 안전 상한. 정상적으로는 장애물 수만큼도 안 돈다. */
const MAX_PUSH = 400;

export interface LayoutInput {
  id: string;
  tag: string | null;
  seq: number;
  /** 트리 판정에 쓴다 (D151). 없으면 트리에 넣지 않는다. */
  kind?: string;
  source?: string;
  /** ResizeObserver 실측 높이. 배치의 **입력**이다(출력이 아니다). */
  height: number;
  /**
   * ResizeObserver 실측 폭(≤ ITEM_W). 역시 배치의 입력이다.
   *
   * 폭이 위치에 영향을 받지 않는 것이 중요하다 — maxWidth가 상수라 어디에
   * 놓든 폭이 같다. 그래서 폭→배치→위치 단방향이 유지되고, 훅 머리말이 경고한
   * "높이 변경 → 재배치 → 높이 변경" 같은 순환이 생기지 않는다.
   */
  width: number;
  pinned: boolean;
  /** pinned일 때만 의미가 있다. */
  x: number;
  y: number;
  parentItemId: string | null;
}

export interface Placed {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Map<string, Placed>;
  /** 태그 → 열 x. 태그 라벨을 그릴 때 쓴다. */
  columnX: Map<string, number>;
  /** 이번 계산에서 확정된 태그 순서. 호출부가 다음 호출에 다시 넘긴다. */
  tagOrder: string[];
}

/** tidy tree의 노드. 자식은 생성 순서다. */
interface TidyNode {
  id: string;
  item: LayoutInput;
  kids: TidyNode[];
}

/**
 * 서브트리가 차지하는 **폭** (D159).
 *
 *     max(자기 폭, 자식들 폭의 합 + 사이 간격)
 *
 * 이 값이 곧 "이 가지가 자리를 얼마나 먹는가"다. 자식이 늘면 여기가 커지고,
 * 커진 만큼 형제들이 밀려난다.
 */
function tidyWidth(n: TidyNode, cache: Map<string, number>): number {
  const own = n.item.width;
  if (!n.kids.length) {
    cache.set(n.id, own);
    return own;
  }
  let sum = 0;
  for (const k of n.kids) sum += tidyWidth(k, cache);
  sum += SIB_GAP * (n.kids.length - 1);
  const w = Math.max(own, sum);
  cache.set(n.id, w);
  return w;
}

/**
 * 서브트리를 놓는다 — 부모는 자식들 **위 가운데**, 자식들은 좌우로 나란히.
 *
 * ## 왜 겹치지 않나 (알고리즘의 성질)
 *
 *   1. 형제의 x 띠는 서로 **겹치지 않는다**(폭을 더해 가며 자리를 준다).
 *   2. 자손은 조상의 띠 **안에** 머문다(자식 띠의 합 ≤ 부모 띠).
 *   3. 자식은 부모의 아래 변보다 **아래**에서 시작한다.
 *
 * 1·2에서 서로 다른 가지는 x가 겹치지 않고, 3에서 같은 가지의 위아래는 y가
 * 겹치지 않는다. 그래서 회피 탐색이 아예 필요 없다 — 겹칠 수가 없다.
 *
 * 고정된 노드(학생이 끌어다 둔 것)는 그 자리를 그대로 쓰고, 그 아래 가지는
 * 그 자리를 기준으로 이어 붙인다. 드래그가 가지째 움직이므로(D154) 서브트리
 * 안의 상대 배치는 이미 맞아 있다.
 */
function placeTidy(
  n: TidyNode,
  left: number,
  top: number,
  widths: Map<string, number>,
  out: Map<string, Placed>,
): void {
  const w = widths.get(n.id) ?? n.item.width;
  const x = n.item.pinned ? n.item.x : left + (w - n.item.width) / 2;
  const y = n.item.pinned ? n.item.y : top;
  out.set(n.id, { x, y });
  if (!n.kids.length) return;

  let kidsW = SIB_GAP * (n.kids.length - 1);
  for (const k of n.kids) kidsW += widths.get(k.id) ?? k.item.width;
  // 자식 띠는 부모 **중심**에 맞춘다 — 부모가 자식들 위 가운데에 온다.
  let cur = x + n.item.width / 2 - kidsW / 2;
  const kidTop = y + n.item.height + ROW_GAP;
  for (const k of n.kids) {
    placeTidy(k, cur, kidTop, widths, out);
    cur += (widths.get(k.id) ?? k.item.width) + SIB_GAP;
  }
}

/** 서브트리에서 가장 아래 변. 트리 밖 글을 그 아래에 놓을 때 쓴다. */
function subtreeBottom(n: TidyNode, out: Map<string, Placed>): number {
  const p = out.get(n.id);
  let b = p ? p.y + n.item.height : 0;
  for (const k of n.kids) b = Math.max(b, subtreeBottom(k, out));
  return b;
}

/** LayoutInput → 트리 판정 입력. 없는 필드는 트리에 못 들어가는 값으로 채운다. */
function asTreeItem(i: LayoutInput): TreeItem {
  return {
    id: i.id,
    tag: i.tag,
    parentItemId: i.parentItemId,
    seq: i.seq,
    kind: i.kind ?? "",
    source: i.source ?? "",
  };
}

/** 태그 없는 아이템이 모이는 열의 이름. 사용자에게는 안 보인다. */
export const UNTAGGED = " untagged";


/**
 * y부터 아래로 훑어 장애물과 겹치지 않는 첫 자리를 찾는다.
 *
 * 종료 근거: 겹쳤다는 것은 `obstacle.bottom > y`라는 뜻이므로 새 y는 항상
 * 이전보다 크다. 단조 증가 + 유한 장애물이라 반드시 끝난다.
 */
function pushDown(
  x: number,
  y: number,
  w: number,
  h: number,
  obstacles: readonly Rect[],
): number {
  let cur = y;
  for (let i = 0; i < MAX_PUSH; i++) {
    const rect: Rect = { x, y: cur, w, h };
    const hit = obstacles.find((o) => intersects(rect, o));
    if (!hit) return cur;
    cur = bottom(hit) + ROW_GAP;
  }
  return cur;
}

/**
 * 전체 배치.
 *
 * @param items      배치 대상 전부(pinned 포함)
 * @param obstacles  그림 요소 등 외부 장애물(이미 패딩이 들어간 사각형)
 * @param prevOrder  이전에 확정된 태그 순서. 열이 움직이지 않게 유지한다.
 */
export function layoutItems(
  items: readonly LayoutInput[],
  obstacles: readonly Rect[] = [],
  prevOrder: readonly string[] = [],
): LayoutResult {
  const positions = new Map<string, Placed>();
  const columnX = new Map<string, number>();

  // 태그 순서: 이전 순서를 그대로 이어받고, 처음 보는 태그만 뒤에 붙인다.
  // seq 오름차순으로 훑어야 "첫 등장 순서"가 결정론적이다.
  const order = [...prevOrder];
  const bySeq = [...items].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  for (const it of bySeq) {
    const tag = it.tag || UNTAGGED;
    if (!order.includes(tag)) order.push(tag);
  }

  // 장애물은 누적된다 — 먼저 놓인 것이 나중 것의 장애물이 된다.
  const blocks: Rect[] = [...obstacles];

  // 1) pinned은 자리를 그대로 쓰고 장애물이 된다.
  for (const it of bySeq) {
    if (!it.pinned) continue;
    positions.set(it.id, { x: it.x, y: it.y });
    blocks.push({ x: it.x, y: it.y, w: it.width, h: it.height });
  }

  // 2) 태그 트리 — **형제 서브트리를 좌우로 벌린다** (D159, tidy tree).
  //
  //    예전에는 한 열에 세로로 쌓고 갈라질 때만 조금 들여썼다. 그러면 가지가
  //    늘수록 세로로만 길어지고, 새 자식이 들어갈 자리는 **비켜서 찾는**
  //    수밖에 없었다(사용자 지적 2026-08-03: "옆으로 밀어내기가 잘 안 돼").
  //
  //    이제 각 서브트리가 **자기 폭을 갖는다.** 자식이 하나 늘면 그 서브트리의
  //    폭이 늘고 형제 서브트리들이 그만큼 좌우로 밀려난다 — 밀려난 서브트리는
  //    자기 자손을 통째로 데리고 간다(자손 좌표가 서브트리 안에서 상대적이라
  //    공짜로 따라온다). 이것이 요구한 "밀어내서 공간 만들기"다.
  const byId = new Map(bySeq.map((i) => [i.id, i]));
  const trees = buildTrees(bySeq.map(asTreeItem));
  const inTree = new Set<string>();

  /** 태그별 뿌리 노드들. */
  const rootsByTag = new Map<string, TidyNode[]>();
  for (const t of trees) {
    const ids = new Set(t.order);
    const kidsOf = new Map<string, string[]>();
    const roots: string[] = [];
    for (const id of t.order) {
      inTree.add(id);
      const p = byId.get(id)?.parentItemId ?? null;
      if (p && ids.has(p)) {
        const arr = kidsOf.get(p) ?? [];
        arr.push(id);
        kidsOf.set(p, arr);
      } else {
        roots.push(id);
      }
    }
    const make = (id: string): TidyNode => ({
      id,
      item: byId.get(id) as LayoutInput,
      kids: (kidsOf.get(id) ?? []).map(make),
    });
    rootsByTag.set(t.tag, roots.map(make));
  }

  // 트리에 못 들어가는 자동 배치 아이템(학생 메모·도판·분류 없는 글).
  const looseByTag = new Map<string, LayoutInput[]>();
  for (const it of bySeq) {
    if (it.pinned || it.parentItemId || inTree.has(it.id)) continue;
    const tag = it.tag || UNTAGGED;
    const arr = looseByTag.get(tag) ?? [];
    arr.push(it);
    looseByTag.set(tag, arr);
  }

  /**
   * 열 x는 **누적**이다. 트리마다 폭이 다르므로(자식이 많은 트리는 넓다)
   * 고정 피치로는 겹치거나 쓸데없이 벌어진다.
   */
  let colCursor = 0;
  for (const tag of order) {
    const roots = rootsByTag.get(tag) ?? [];
    const loose = looseByTag.get(tag) ?? [];
    if (!roots.length && !loose.length) continue;

    columnX.set(tag, colCursor);
    const widths = new Map<string, number>();
    for (const r of roots) tidyWidth(r, widths);

    let cur = colCursor;
    let bottom = COL_TOP;
    for (const r of roots) {
      placeTidy(r, cur, COL_TOP, widths, positions);
      cur += (widths.get(r.id) ?? r.item.width) + SIB_GAP;
      bottom = Math.max(bottom, subtreeBottom(r, positions));
    }
    const treeW = roots.length ? cur - SIB_GAP - colCursor : 0;

    /**
     * 트리 밖 글(학생 메모·도판)은 트리 **아래**에 세로로 쌓는다.
     *
     * 이쪽은 **회피 탐색을 그대로 쓴다.** 트리와 달리 구조가 없어서 서로
     * 밀어낼 근거가 없고, 그림 요소나 학생이 끌어다 둔 카드와 부딪히면
     * 비켜 가는 편이 맞다. 트리 배치가 무겹침을 보장하는 것과는 다른 이유다.
     */
    let y = roots.length ? bottom + ROW_GAP : COL_TOP;
    let looseW = 0;
    for (const it of loose) {
      const at = pushDown(colCursor, y, it.width, it.height, blocks);
      positions.set(it.id, { x: colCursor, y: at });
      blocks.push({ x: colCursor, y: at, w: it.width, h: it.height });
      y = at + it.height + ROW_GAP;
      looseW = Math.max(looseW, it.width);
    }
    colCursor += Math.max(treeW, looseW, ITEM_W) + COL_GAP;
  }

  // 3) 트리 밖 자식(학생 메모에 대한 옛 AI 응답) — 부모 옆에.
  //    부모가 아직 안 놓였으면(순서가 꼬였거나 부모가 지워졌으면) 열 흐름으로
  //    떨어뜨린다. 화면에서 사라지는 것보다 낫다.
  for (const it of bySeq) {
    if (it.pinned || !it.parentItemId || inTree.has(it.id)) continue;
    const parent = positions.get(it.parentItemId);
    const parentItem = items.find((p) => p.id === it.parentItemId);
    if (!parent || !parentItem) {
      // 부모를 잃은 글. 자기 열 아래쪽 빈 자리를 찾아 떨어뜨린다 — 화면에서
      // 사라지는 것보다 낫다. 드문 경로라 회피 탐색으로 충분하다.
      const tag = it.tag || UNTAGGED;
      const x = columnX.get(tag) ?? 0;
      const y = pushDown(x, COL_TOP, it.width, it.height, blocks);
      positions.set(it.id, { x, y });
      blocks.push({ x, y, w: it.width, h: it.height });
      continue;
    }
    const spot = placeBesideParent(
      { x: parent.x, y: parent.y, w: parentItem.width, h: parentItem.height },
      it.width,
      it.height,
      blocks,
    );
    positions.set(it.id, spot);
    blocks.push({ x: spot.x, y: spot.y, w: it.width, h: it.height });
  }

  return { positions, columnX, tagOrder: order };
}

/**
 * AI 응답을 부모 메모의 **오른쪽**에 붙인다 (D126).
 *
 * 열 흐름보다 우선한다 — 연결선이 짧고 시선이 자연스럽게 왼→오른쪽으로 흐른다.
 * 오른쪽이 막혔으면 아래로 밀어낸다(왼쪽은 시도하지 않는다. 응답이 질문 왼쪽에
 * 오면 읽는 순서가 뒤집힌다).
 */
export function placeBesideParent(
  parent: Rect,
  width: number,
  height: number,
  obstacles: readonly Rect[],
): Placed {
  const x = parent.x + parent.w + CHILD_GAP;
  // 부모의 윗변에 맞춘다 — 연결선이 수평에 가까워 읽기 쉽다.
  const y = pushDown(x, parent.y, width, height, obstacles);
  return { x, y };
}

/** 배치 결과 + 실측 크기 → 사각형. 카메라 이동·미니맵·연결선이 쓴다. */
export function rectOf(pos: Placed, size: { w: number; h: number }): Rect {
  return { x: pos.x, y: pos.y, w: size.w, h: size.h };
}
