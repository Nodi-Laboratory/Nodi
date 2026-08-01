/**
 * 재배치 — 태그 무리를 **최소한으로 움직여** 서로 갈라 놓는다 (D143).
 *
 * ## 열 배치를 다시 돌리는 것이 아니다
 *
 * `layoutItems`(D123)는 자리를 **처음부터** 정한다. 학생이 옮겨 둔 것을 전부
 * 없던 일로 만드는 셈이라, 한참 정리해 놓은 캔버스에서는 쓸 수 없다.
 *
 * 여기서는 지금 자리를 출발점으로 삼는다. 이미 잘 나뉘어 있으면 **아무것도
 * 움직이지 않는다** — 버튼을 눌러도 화면이 그대로인 것이 옳은 결과다.
 *
 * ## 무리는 통째로 움직인다
 *
 * 태그 하나가 강체(rigid body)다. 무리 안의 상대 위치는 손대지 않는다 —
 * 학생이 같은 태그 안에서 정렬해 둔 것까지 흐트러뜨리면 "재배치"가 아니라
 * "초기화"다.
 *
 * 부모가 있는 글(질문에 딸린 답)은 태그가 없어도 **부모 무리에 붙는다.**
 * 떨어뜨리면 연결선만 길어지고 관계가 안 보인다.
 *
 * ## 겹침은 무리 상자가 아니라 **글 상자끼리** 본다
 *
 * 무리의 바운딩 박스로 판정하면, 한 글만 멀리 끌어다 놓은 태그의 상자가
 * 캔버스 절반을 덮어 아무 상관 없는 무리까지 밀어낸다. 무리는 통째로
 * 움직이되 **닿았는지는 글 상자 단위로** 본다.
 *
 * ## 어느 쪽으로 미나 — 최소 이동 벡터
 *
 * 겹친 두 상자는 x로 빼거나 y로 빼서 뗄 수 있다. **덜 파고든 축**으로 민다
 * (최소 이동 벡터, MTV). 그리고 미는 양을 두 무리가 나눠 갖는데,
 * **글이 적은 무리가 더 많이 움직인다** — 총 이동량 Σ(글 수 × 거리)를 줄이는
 * 배분이다.
 *
 * 미는 순서는 짝 하나씩이고, 민 결과를 **바로 반영한 뒤** 다음 짝을 본다.
 * 모든 짝의 밀림을 모아 한꺼번에 평균하면, 양쪽에서 밀리는 무리는 두 힘이
 * 상쇄돼 제자리에 갇힌다 — 실제로 그렇게 만들었다가 300번을 돌고도 36px밖에
 * 못 움직이는 것을 실측하고 고쳤다.
 *
 * 마지막에 전체 평균 이동을 빼서 **화면 전체가 한쪽으로 흐르는 것**을 없앤다.
 * 모두에게 같은 값을 빼는 것은 서로의 간격을 바꾸지 않으므로 안전하고,
 * 그만큼 총 이동량이 줄어든다.
 *
 * ## 그림은 보지 않는다
 *
 * 캔버스 도구로 그린 요소는 고려하지 않는다(사용자 지시). 학생이 글 위에
 * 표시로 그어 둔 선까지 장애물로 치면, 표시를 해 둘수록 글이 밀려난다.
 */

/** 무리 사이 최소 여백. 이보다 붙어 있으면 어느 태그인지 눈으로 안 갈린다. */
export const TAG_GAP = 160;

/**
 * 한 번에 얼마나 밀 것인가.
 *
 * 1이면 **그 접촉을 정확히 해소하는 만큼** 민다. 처음에는 0.6으로 두고 모든
 * 짝의 밀림을 모아 평균했는데, 세 무리가 서로 겹치면 왼쪽으로 미는 힘과
 * 오른쪽으로 미는 힘이 **상쇄돼** 300번을 돌고도 36px밖에 못 움직였다(실측).
 * 짝을 하나씩 즉시 해소하는 지금 방식에서는 정확히 미는 편이 빠르고 덜 움직인다.
 */
const RELAX = 1;

/** 반복 상한. 정상적인 캔버스는 수십 번 안에 끝난다. */
const MAX_ITER = 2000;

/**
 * 몇 바퀴째 진전이 없으면 **마지막 수단**으로 넘어갈 것인가.
 *
 * 조금씩 미는 것만으로는 못 푸는 배치가 있다. 태그 가의 글 둘이 멀리 떨어져
 * 있고 그 사이에 태그 나가 끼면, 나는 왼쪽 글에 밀려 오른쪽으로, 오른쪽 글에
 * 밀려 왼쪽으로 가며 제자리를 오간다.
 */
const STALL_LIMIT = 400;

/** 이보다 작게 움직였으면 안 움직인 것으로 친다(화면에서 구별 못 한다). */
const EPS = 0.5;

export interface RegroupItem {
  id: string;
  tag: string | null;
  parentItemId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegroupResult {
  /** 옮겨야 하는 글 → 새 좌표. 안 움직인 글은 아예 없다. */
  moves: Map<string, { x: number; y: number }>;
  /** 무리 수. 2 미만이면 갈라 놓을 것이 없다. */
  groups: number;
  /**
   * 밀기로 못 풀어 **가로로 펼쳤나**. 드물다 — 서로 다른 태그의 글이 번갈아
   * 끼어 있을 때만 그렇다.
   */
  exhausted: boolean;
}

/**
 * 각 글이 속한 무리의 키.
 *
 *   태그가 있으면        태그
 *   부모가 있으면        부모의 무리(재귀)
 *   둘 다 없으면         혼자 한 무리
 *
 * 태그 없는 메모를 전부 한 무리로 묶으면, 캔버스 여기저기 흩어 둔 낙서들이
 * 강체가 되어 통째로 끌려다닌다. 혼자 두면 각자 최소한으로 비켜난다.
 */
export function groupKeys(items: readonly RegroupItem[]): Map<string, string> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Map<string, string>();

  const resolve = (item: RegroupItem, seen: Set<string>): string => {
    if (item.tag) return `tag:${item.tag}`;
    const parent = item.parentItemId ? byId.get(item.parentItemId) : undefined;
    // 순환 참조는 데이터가 깨졌을 때만 생기지만, 여기서 멈추지 않으면 앱이 언다.
    if (!parent || seen.has(parent.id)) return `solo:${item.id}`;
    seen.add(item.id);
    return resolve(parent, seen);
  };

  for (const it of items) out.set(it.id, resolve(it, new Set([it.id])));
  return out;
}

interface Delta {
  dx: number;
  dy: number;
}

export function regroup(
  items: readonly RegroupItem[],
  gap: number = TAG_GAP,
): RegroupResult {
  const keys = groupKeys(items);
  const groupOf = new Map<string, RegroupItem[]>();
  for (const it of items) {
    const k = keys.get(it.id) ?? `solo:${it.id}`;
    const list = groupOf.get(k);
    if (list) list.push(it);
    else groupOf.set(k, [it]);
  }

  const delta = new Map<string, Delta>();
  for (const k of groupOf.keys()) delta.set(k, { dx: 0, dy: 0 });

  if (groupOf.size < 2) {
    return { moves: new Map(), groups: groupOf.size, exhausted: false };
  }

  const list = [...groupOf.entries()];
  let exhausted = true;

  let bestPenetration = Infinity;
  let stall = 0;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let touched = false;
    let penetration = 0;

    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const [ka, itemsA] = list[a];
        const [kb, itemsB] = list[b];
        const da = delta.get(ka)!;
        const db = delta.get(kb)!;

        /**
         * 두 무리 사이에서 **가장 깊이 파고든 접촉 하나**만 해소한다.
         *
         * 접촉마다 밀면 글이 많은 무리끼리는 같은 짝을 여러 번 밀어 필요보다
         * 훨씬 멀리 간다. 제일 나쁜 접촉을 풀고 다음 짝으로 넘어가면, 남은
         * 접촉은 다음 바퀴가 본다.
         */
        let worst: { x: number; y: number } | null = null;
        let depth = 0;
        for (const ia of itemsA) {
          for (const ib of itemsB) {
            const push = separate(ia, da, ib, db, gap, ka < kb ? -1 : 1);
            if (!push) continue;
            const d = Math.abs(push.x) + Math.abs(push.y);
            if (d > depth) {
              depth = d;
              worst = push;
            }
          }
        }
        if (!worst) continue;
        touched = true;
        penetration += depth;
        // 글이 적은 무리가 더 많이 움직인다 — 총 이동량이 줄어든다.
        const wa = itemsB.length / (itemsA.length + itemsB.length);
        const wb = 1 - wa;
        da.dx += RELAX * worst.x * wa;
        da.dy += RELAX * worst.y * wa;
        db.dx -= RELAX * worst.x * wb;
        db.dy -= RELAX * worst.y * wb;
      }
    }

    if (!touched) {
      exhausted = false;
      break;
    }
    /**
     * 진전이 없으면(제자리를 오가면) 한 무리를 통째로 빼서 매듭을 끊는다.
     *
     * **직전 바퀴가 아니라 지금까지의 최선과 견준다.** 처음에는 직전과
     * 비교했는데, 좌우로 오가는 교착은 한 바퀴 걸러 한 번씩 좋아져서
     * 정체로 잡히지 않았다(무작위 100케이스 중 2개가 그렇게 남았다).
     */
    if (penetration < bestPenetration - 1) {
      bestPenetration = penetration;
      stall = 0;
    } else if (++stall >= STALL_LIMIT) {
      break; // 더 밀어 봐야 제자리다 — 아래 펼치기로 넘어간다
    }
  }

  // 아직 닿아 있으면(밀기로는 못 푸는 배치) 가로로 펼쳐 확실히 가른다.
  if (exhausted && hasContact(list, delta, gap)) spreadOut(list, delta, gap);

  // 전체가 한쪽으로 흐른 만큼을 되돌린다(간격은 그대로, 이동량만 줄어든다).
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const [k, g] of groupOf) {
    const d = delta.get(k)!;
    sx += d.dx * g.length;
    sy += d.dy * g.length;
    n += g.length;
  }
  const mx = n ? sx / n : 0;
  const my = n ? sy / n : 0;

  const moves = new Map<string, { x: number; y: number }>();
  for (const [k, g] of groupOf) {
    const d = delta.get(k)!;
    const dx = d.dx - mx;
    const dy = d.dy - my;
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) continue;
    for (const it of g) moves.set(it.id, { x: it.x + dx, y: it.y + dy });
  }

  return { moves, groups: groupOf.size, exhausted };
}

/**
 * 마지막 수단 — 무리를 **가로로 펼친다**.
 *
 * 밀기만으로는 못 푸는 배치가 있다. 서로 다른 태그의 글이 번갈아 끼어 있으면
 * 무리를 통째로 옮기는 한 어떤 방향으로도 조금씩은 겹친다.
 *
 * 그때는 무리를 지금의 좌우 순서 그대로 한 줄로 늘어놓는다. x 범위가 서로
 * 겹치지 않으므로 **분리가 보장된다.** y는 손대지 않는다 — 세로로 정리해 둔
 * 학생의 작업이 남고, 이동량도 그만큼 준다.
 *
 * 처음에는 "가장 얽힌 무리 하나를 상대 범위 밖으로 던지기"였는데, 던진 무리가
 * 또 다른 무리를 밀어 연쇄가 났다 — 무작위 1500케이스에서 최대 이동이
 * 17,926px까지 튀고도 36건이 안 풀렸다(실측). 한 줄 펼치기는 한 번에 끝난다.
 */
function spreadOut(
  list: readonly (readonly [string, RegroupItem[]])[],
  delta: Map<string, Delta>,
  gap: number,
): void {
  const boxes = list
    .map(([k, items]) => ({ k, b: boundsOf(items, delta.get(k)!) }))
    .sort((p, q) => p.b.x0 + p.b.x1 - (q.b.x0 + q.b.x1));

  let cursor = boxes[0]?.b.x0 ?? 0;
  for (const { k, b } of boxes) {
    const d = delta.get(k)!;
    d.dx += cursor - b.x0;
    cursor += b.x1 - b.x0 + gap;
  }
}

/** 서로 다른 무리의 글이 아직 `gap`보다 가까운가. */
function hasContact(
  list: readonly (readonly [string, RegroupItem[]])[],
  delta: Map<string, Delta>,
  gap: number,
): boolean {
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      const [ka, itemsA] = list[a];
      const [kb, itemsB] = list[b];
      const da = delta.get(ka)!;
      const db = delta.get(kb)!;
      for (const ia of itemsA) {
        for (const ib of itemsB) {
          if (separate(ia, da, ib, db, gap, ka < kb ? -1 : 1)) return true;
        }
      }
    }
  }
  return false;
}

/** 무리가 차지하는 전체 범위(현재 이동량 반영). */
function boundsOf(items: readonly RegroupItem[], d: Delta) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const i of items) {
    x0 = Math.min(x0, i.x + d.dx);
    y0 = Math.min(y0, i.y + d.dy);
    x1 = Math.max(x1, i.x + d.dx + i.w);
    y1 = Math.max(y1, i.y + d.dy + i.h);
  }
  return { x0, y0, x1, y1 };
}

/**
 * 두 상자를 떼는 최소 이동 벡터. 이미 `gap`만큼 떨어져 있으면 null.
 *
 * `tie`는 중심이 정확히 겹쳤을 때 어느 쪽으로 밀지 — 키 순서로 정해
 * **같은 입력이 항상 같은 결과**를 내게 한다(D90의 결정론).
 */
function separate(
  a: RegroupItem,
  da: Delta,
  b: RegroupItem,
  db: Delta,
  gap: number,
  tie: 1 | -1,
): { x: number; y: number } | null {
  const acx = a.x + da.dx + a.w / 2;
  const acy = a.y + da.dy + a.h / 2;
  const bcx = b.x + db.dx + b.w / 2;
  const bcy = b.y + db.dy + b.h / 2;

  const ox = (a.w + b.w) / 2 + gap - Math.abs(acx - bcx);
  const oy = (a.h + b.h) / 2 + gap - Math.abs(acy - bcy);
  if (ox <= 0 || oy <= 0) return null;

  if (ox <= oy) {
    const dir = acx === bcx ? tie : acx > bcx ? 1 : -1;
    return { x: ox * dir, y: 0 };
  }
  const dir = acy === bcy ? tie : acy > bcy ? 1 : -1;
  return { x: 0, y: oy * dir };
}

