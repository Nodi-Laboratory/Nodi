/**
 * 카드 밀어내기 (D207) — **카드는 절대 겹치지 않는다.**
 *
 * ## 무엇을 푸는가
 *
 * 배치 엔진(D123)은 자기가 놓는 카드끼리 안 겹치는 것을 보장한다. 그런데
 * 학생이 손으로 끌면 그 보장이 깨진다 — 아무 데나 놓을 수 있으니 남의 위에
 * 얹힌다. 겹친 카드는 글이 서로를 가려 **읽을 수 없다.**
 *
 * 막는 방법은 둘이다. 놓지 못하게 하거나(손과 싸운다), **비켜 주거나.**
 * 후자를 고른다 — 사용자 지시 2026-08-07: "배경에 있는 카드들이 밀려나는
 * 애니메이션을 추가하고 밀려난 상태로 드래그를 끝내면 그 위치에 겹침없이
 * 놓이게 된다."
 *
 * ## 왜 순수 함수인가
 *
 * 이 파일이 정하는 것은 `detachDrag`와 같은 종류다 — **손맛**이다. 얼마나
 * 세게 밀리는지, 어느 방향으로 비키는지, 밀린 것들끼리 또 겹치지 않는지.
 * 눈으로는 "좀 이상한데"까지만 알 수 있고 어디가 틀렸는지는 못 짚는다.
 *
 * ## 알고리즘
 *
 * 각 카드마다 **가장 얕게 빠져나갈 수 있는 축**으로 민다(최소 이동 벡터).
 * 대각선으로 밀면 두 축 다 움직여 카드가 멀리 날아가고, 무엇이 왜 움직였는지
 * 안 보인다. 한 축으로만 미끄러지면 "비켜 주는" 동작으로 읽힌다.
 *
 * 밀린 카드가 또 다른 카드를 밀 수 있으므로 몇 판 반복한다. **판 수에 상한이
 * 있는 것이 성질이다** — 수렴을 기다리지 않는다(D123이 d3-force를 버린 이유와
 * 같다). 상한에 걸려도 결과는 "덜 밀린" 상태이지 겹친 채로 끝나지 않는다.
 */

import type { Rect } from "./rect";

export interface PushCandidate {
  id: string;
  rect: Rect;
}

export interface PushOptions {
  /** 두 카드 사이에 남길 최소 간격(world px). */
  gap: number;
  /**
   * 밀어내는 정도(0~1.5). 1이면 딱 안 겹칠 만큼만, 그보다 크면 여유를 두고
   * 더 밀린다. 0이면 아무도 안 밀린다(기능을 끈 것과 같다).
   */
  strength: number;
  /** 연쇄 반복 상한. 밀린 카드가 또 밀 수 있다. */
  passes?: number;
}

export interface Displacement {
  dx: number;
  dy: number;
}

const DEFAULT_PASSES = 3;
/** 이보다 작은 이동은 없는 것으로 친다(부동소수 찌꺼기·눈에 안 보이는 떨림). */
const EPS = 0.5;

function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/**
 * `target`이 `blocker`에서 빠져나가는 **최소 이동 벡터**.
 *
 * 네 방향(좌·우·상·하) 중 가장 짧은 쪽을 고른다. 같으면 세로를 고른다 —
 * 카드는 열로 배치되므로(D123) 가로로 밀면 남의 열을 침범하고, 세로로 밀면
 * 자기 열 안에서 비킨다.
 */
export function minTranslation(target: Rect, blocker: Rect): Displacement {
  if (!overlaps(target, blocker)) return { dx: 0, dy: 0 };
  const left = blocker.x - (target.x + target.w); // 음수
  const right = blocker.x + blocker.w - target.x; // 양수
  const up = blocker.y - (target.y + target.h);
  const down = blocker.y + blocker.h - target.y;
  const bestX = Math.abs(left) <= Math.abs(right) ? left : right;
  const bestY = Math.abs(up) <= Math.abs(down) ? up : down;
  return Math.abs(bestX) < Math.abs(bestY)
    ? { dx: bestX, dy: 0 }
    : { dx: 0, dy: bestY };
}

/**
 * 끄는 카드들이 지금 자리에 있을 때, **나머지 카드들이 비켜야 하는 양.**
 *
 * 돌려주는 Map에는 **움직이는 것만** 담는다 — 안 밀리는 카드까지 담으면
 * 호출부가 매 프레임 전부를 DOM에 쓰게 된다.
 *
 * `moving`은 이미 옮겨진 자리(포인터를 따라간 뒤)여야 한다. 원래 자리를 주면
 * 카드가 아직 오지도 않은 곳의 카드를 민다.
 */
export function pushAway(
  moving: readonly Rect[],
  statics: readonly PushCandidate[],
  opts: PushOptions,
): Map<string, Displacement> {
  const out = new Map<string, Displacement>();
  if (opts.strength <= 0 || !moving.length || !statics.length) return out;

  const passes = opts.passes ?? DEFAULT_PASSES;
  const gap = Math.max(0, opts.gap);
  // 간격은 **한쪽에 절반씩** 준다. 양쪽 상자를 gap만큼씩 부풀리면 실제
  // 간격이 2배가 되어 관리자가 넣은 값과 화면이 어긋난다.
  const half = gap / 2;
  const movers = moving.map((r) => inflate(r, half));

  /**
   * **가까운 카드만 계산에 넣는다** (넓은 단계).
   *
   * 이 함수는 드래그 프레임마다 돈다. 이웃 검사가 카드 수의 제곱이라 그냥
   * 두면 학기 말 캔버스에서 프레임을 통째로 먹는다(실측: 300장 2.44ms,
   * 600장이면 10ms — 한 프레임 예산 16.7ms의 절반이다).
   *
   * 끄는 카드에서 아주 멀리 있는 카드는 이번 프레임에 밀릴 수도, 밀린
   * 이웃에 떠밀릴 수도 없다. 반경은 **한 판에 밀릴 수 있는 최대 거리**로
   * 잡는다 — 카드 하나 크기 + 간격에 판 수를 곱한 값이면 넉넉하다.
   */
  let qx0 = Infinity;
  let qy0 = Infinity;
  let qx1 = -Infinity;
  let qy1 = -Infinity;
  let biggest = 0;
  for (const m of movers) {
    qx0 = Math.min(qx0, m.x);
    qy0 = Math.min(qy0, m.y);
    qx1 = Math.max(qx1, m.x + m.w);
    qy1 = Math.max(qy1, m.y + m.h);
    biggest = Math.max(biggest, m.w, m.h);
  }
  for (const s of statics) biggest = Math.max(biggest, s.rect.w, s.rect.h);
  const reach = (biggest + gap) * (passes + 1);
  const near: PushCandidate[] = [];
  for (const s of statics) {
    const r = s.rect;
    if (
      r.x + r.w >= qx0 - reach &&
      r.x <= qx1 + reach &&
      r.y + r.h >= qy0 - reach &&
      r.y <= qy1 + reach
    ) {
      near.push(s);
    }
  }
  if (!near.length) return out;

  /** 지금까지 밀린 결과를 반영한 자리. */
  const at = new Map<string, Rect>(near.map((s) => [s.id, s.rect]));

  for (let pass = 0; pass < passes; pass++) {
    let touched = false;
    for (const s of near) {
      const cur = at.get(s.id)!;
      const box = inflate(cur, half);
      let dx = 0;
      let dy = 0;
      // 1) 끄는 카드에서 비킨다.
      for (const m of movers) {
        const t = minTranslation(box, m);
        dx += t.dx;
        dy += t.dy;
      }
      // 2) 이미 밀린 이웃과도 안 겹쳐야 한다. **모든 카드 종류가 대상이다**
      //    (사용자 지시: "모든 카드 종류는 겹칠 수 없다").
      for (const o of near) {
        if (o.id === s.id) continue;
        const t = minTranslation(box, inflate(at.get(o.id)!, half));
        dx += t.dx;
        dy += t.dy;
      }
      if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) continue;
      touched = true;
      const next = {
        x: cur.x + dx * opts.strength,
        y: cur.y + dy * opts.strength,
      };
      at.set(s.id, { ...cur, ...next });
    }
    if (!touched) break;
  }

  /**
   * **마지막은 끄는 카드가 이긴다.**
   *
   * 위 반복에서 이웃이 서로를 밀다 보면, 방금 비켜난 카드가 이웃에게 떠밀려
   * 다시 끄는 카드 밑으로 들어간다(무작위 600장면에서 6건 나왔다). 손에
   * 들린 카드와 겹치는 것은 학생 눈에 곧바로 보이므로, 그 하나만은 성질로
   * 보장한다 — 이웃끼리의 남은 겹침은 판 수 상한 안에서 최선을 다한다.
   */
  for (const s of near) {
    const cur = at.get(s.id)!;
    let dx = 0;
    let dy = 0;
    for (const m of movers) {
      const t = minTranslation(inflate({ ...cur, x: cur.x + dx, y: cur.y + dy }, half), m);
      dx += t.dx;
      dy += t.dy;
    }
    if (Math.abs(dx) >= EPS || Math.abs(dy) >= EPS) {
      at.set(s.id, { ...cur, x: cur.x + dx * opts.strength, y: cur.y + dy * opts.strength });
    }
  }

  for (const s of near) {
    const now = at.get(s.id)!;
    const dx = now.x - s.rect.x;
    const dy = now.y - s.rect.y;
    if (Math.abs(dx) >= EPS || Math.abs(dy) >= EPS) out.set(s.id, { dx, dy });
  }
  return out;
}

/**
 * 겹치는 쌍이 하나라도 있나. **시험용**이다 — 밀어낸 결과가 정말 안 겹치는지
 * 눈이 아니라 계산으로 확인한다.
 *
 * `tol`보다 얕은 겹침은 세지 않는다. 밀어내기가 `EPS`보다 작은 이동을 버리기
 * 때문에 0.4px씩 물린 채로 끝나는 경우가 생기는데, 그걸 없애려고 매 프레임
 * 반 픽셀씩 밀면 **카드가 미세하게 떨린다.** 눈에 안 보이는 겹침보다 떨림이
 * 나쁘다.
 */
export function anyOverlap(rects: readonly Rect[], gap = 0, tol = EPS): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = inflate(rects[i], gap / 2);
      const b = inflate(rects[j], gap / 2);
      const depth = Math.min(
        Math.min(a.x + a.w - b.x, b.x + b.w - a.x),
        Math.min(a.y + a.h - b.y, b.y + b.h - a.y),
      );
      if (depth > tol) return true;
    }
  }
  return false;
}
