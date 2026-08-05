/**
 * 떼어내기·붙이기 드래그의 기하 (D180).
 *
 * ## 무엇을 푸는가
 *
 * 학생이 학습 내용을 **자기 손으로 다시 엮을** 수 있어야 한다. 지금은 카드를
 * 옮길 수만 있고 관계를 바꾸려면 메뉴로 분류를 고쳐야 한다 — 마인드맵을 쓰는
 * 사람이 기대하는 동작이 아니다.
 *
 * 그래서 **끌면 끊기고, 가져다 대면 붙는다.** 다만 그것이 기본 드래그면
 * 카드를 옮기려다 관계가 끊긴다. 그래서 전용 도구(별 포인터)를 켰을 때만
 * 이 규칙이 돈다.
 *
 * ## 왜 순수 함수인가
 *
 * 이 파일이 정하는 것은 **손맛**이다 — 얼마나 당겨야 끊기는지, 끊기기 전까지
 * 카드가 얼마나 뒤처지는지, 어느 거리에서 자석이 걸리는지. 눈으로는 "좀
 * 이상한데"까지만 알 수 있고 어디가 틀렸는지는 못 짚는다. `inkScene`·
 * `connector`가 lib에 있는 것과 같은 이유다.
 */

import type { Rect } from "./rect";

export interface Pt {
  x: number;
  y: number;
}

/* ────────────────────────── 장력 ────────────────────────── */

/**
 * 끊기는 거리(world px).
 *
 * 카드 폭(560)의 절반쯤이다. 이보다 짧으면 자리를 조금 다듬다가 끊기고,
 * 길면 "안 끊긴다"고 느낀다.
 */
export const BREAK_DIST = 260;

/**
 * 끊기기 직전에 카드가 뒤처지는 최대 비율.
 *
 * 0.55면 끊기는 순간 카드가 포인터보다 **140px쯤 뒤에** 있다가 튀어나간다.
 * 처음엔 0.38이었는데 **저항이 거의 안 느껴진다**는 지적을 받았다(사용자
 * 2026-08-05: "장력이 더 쌔야하고"). 고무줄은 끊기 직전에 확실히 버텨야 한다.
 */
const LAG_MAX = 0.55;

/**
 * 당긴 거리 → **카드가 실제로 따라오는 거리.**
 *
 * 처음에는 1:1로 따라오다가 끊김이 가까워질수록 뒤처진다(제곱). 처음부터
 * 뒤처지게 하면 카드를 조금 옮기려는 것마저 굼떠 보인다 — 저항은 **끊길
 * 무렵에만** 느껴져야 한다.
 *
 * `d >= BREAK_DIST`면 저항이 사라진다(끊긴 뒤라 포인터에 딱 붙는다).
 */
export function tensionPull(d: number, breakAt = BREAK_DIST): number {
  if (d <= 0) return 0;
  if (d >= breakAt) return d;
  const t = d / breakAt;
  return d * (1 - LAG_MAX * t * t);
}

/** 0~1. 연결선이 얼마나 팽팽한가 — 굵기·색·떨림을 이 값으로 몬다. */
export function strain(d: number, breakAt = BREAK_DIST): number {
  if (d <= 0) return 0;
  return Math.min(1, d / breakAt);
}

/** 뒤처짐을 반영한 카드 위치(포인터가 끈 만큼에서 저항을 뺀 자리). */
export function laggedDelta(dx: number, dy: number, breakAt = BREAK_DIST): Pt {
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 0, y: 0 };
  const k = tensionPull(d, breakAt) / d;
  return { x: dx * k, y: dy * k };
}

/* ────────────────────────── 자석 ────────────────────────── */

/**
 * 자석이 걸리기 시작하는 간격(world px, 상자 사이 최단 거리).
 *
 * 이 거리부터 카드가 포인터를 벗어나 부모 쪽으로 끌린다.
 *
 * 220에서 시작했는데 **잘 안 걸린다**는 지적을 받았다(사용자 2026-08-05).
 * 카드가 560px 폭이라 220은 카드 반쪽도 안 되는 거리다 — 학생 눈에는 거의
 * 겹쳐야 반응하는 셈이었다. 카드 한 장 폭만큼으로 넓힌다.
 */
export const MAGNET_DIST = 560;

/**
 * 붙는 간격. 여기까지 오면 연결선이 **팍** 생긴다.
 *
 * 자석 반경과 나눠 둔 이유는 "끌리는 구간"이 있어야 붙는 순간이 사건으로
 * 읽히기 때문이다. 하나로 두면 경계에서 붙었다 떨어졌다 깜박인다.
 *
 * 96 → 240. "근처로 이동하면 **바로** 붙어야 한다"는 요구(사용자 2026-08-05).
 * 자석 반경의 절반 아래로 두어 끌리는 구간은 남긴다.
 */
export const SNAP_DIST = 240;

/**
 * 자석이 카드를 부모 쪽으로 당기는 최대 거리(world px).
 *
 * 46 → 260. 요구는 "**부모 노드 후보 근처로 카드가 끌려가야** 한다"는 것이다
 * (사용자 2026-08-05). 46px은 포인터에서 살짝 벗어나는 정도라 끌린다는 느낌이
 * 안 났다. 지금은 붙는 거리 안에서 남은 간격을 거의 다 메운다 — 손을 떼기
 * 전에 이미 제자리에 가 있다.
 */
const MAGNET_PULL = 260;

/** 두 사각형 사이 최단 거리. 겹치면 0. */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

function center(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export interface Candidate {
  id: string;
  rect: Rect;
}

export interface MagnetState {
  /** 붙을 후보. 없으면 null. */
  id: string | null;
  /** 0~1. 1이면 붙는 거리 안이다. */
  grip: number;
  /** 지금 붙일 수 있나(연결선을 실선으로 그린다). */
  snapped: boolean;
  /** 카드를 부모 쪽으로 밀 양(world). */
  pull: Pt;
}

export const NO_MAGNET: MagnetState = {
  id: null,
  grip: 0,
  snapped: false,
  pull: { x: 0, y: 0 },
};

/**
 * 지금 자리에서 어느 카드에 붙으려 하는가.
 *
 * **가장 가까운 하나만** 본다. 여럿을 후보로 두면 경계에서 대상이 바뀌며
 * 연결선이 깜박이고, 학생은 무엇에 붙을지 예측할 수 없다.
 *
 * `blocked`에는 자기 자신과 **자기 자손**이 들어온다 — 자기 가지에 자기를
 * 붙이면 순환이 생긴다. 트리가 순환을 방어하긴 하지만(`buildTrees`), 애초에
 * 만들지 않는 편이 낫다.
 */
export function magnetFor(
  card: Rect,
  candidates: readonly Candidate[],
  blocked: ReadonlySet<string>,
  opts: { magnet?: number; snap?: number } = {},
): MagnetState {
  const reach = opts.magnet ?? MAGNET_DIST;
  const snapAt = opts.snap ?? SNAP_DIST;
  let best: Candidate | null = null;
  let bestGap = Infinity;
  for (const c of candidates) {
    if (blocked.has(c.id)) continue;
    const g = rectGap(card, c.rect);
    if (g < bestGap) {
      bestGap = g;
      best = c;
    }
  }
  if (!best || bestGap > reach) return NO_MAGNET;

  /**
   * 0(자석 경계) → 1(붙는 거리). 붙는 거리 안에서는 계속 1이다.
   *
   * **제곱근을 씌운다.** 선형이면 경계 근처에서 끌림이 0에 가까워 "자석이
   * 안 걸린다"고 느껴진다(사용자 2026-08-05). 제곱근은 걸리는 순간부터
   * 곧바로 힘이 붙는다 — 실제 자석이 그렇다.
   */
  const raw =
    bestGap <= snapAt ? 1 : (reach - bestGap) / Math.max(1, reach - snapAt);
  const grip = Math.sqrt(Math.max(0, Math.min(1, raw)));
  const from = center(card);
  const to = center(best.rect);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  /**
   * 당기는 양은 **간격을 넘지 않는다.** 넘으면 카드가 부모를 파고들어 겹친
   * 채로 보인다 — 붙는 것이 아니라 잡아먹는 것으로 보인다.
   *
   * 0.8 → 0.92: 자석을 세게 하면서도 이 상한은 남긴다. 끌려가되 겹치지는
   * 않는 것이 "붙었다"의 그림이다.
   */
  const amount = Math.min(MAGNET_PULL * grip, bestGap * 0.92);
  return {
    id: best.id,
    grip,
    snapped: bestGap <= snapAt,
    pull: { x: (dx / d) * amount, y: (dy / d) * amount },
  };
}

/* ────────────────────────── 드래그 한 판 ────────────────────────── */

export interface DetachInput {
  /** 포인터가 누른 뒤 움직인 양(world). */
  dx: number;
  dy: number;
  /** 이 카드가 지금 트리 부모를 갖고 있나. 없으면 끊을 것이 없다. */
  hasParent: boolean;
  /** 이미 끊긴 뒤인가(한 번 끊기면 다시 붙기 전까지 장력이 없다). */
  broken: boolean;
  /** 카드의 원래 자리(world). */
  rect: Rect;
  /** 붙을 수 있는 카드들. */
  candidates: readonly Candidate[];
  /** 후보에서 뺄 id(자기 자신 + 자손). */
  blocked: ReadonlySet<string>;
  breakAt?: number;
}

export interface DetachState {
  /** 카드를 실제로 옮길 양(world). 장력·자석이 다 반영된 값. */
  offset: Pt;
  /** 0~1 팽팽함. 아직 안 끊겼을 때만 0보다 크다. */
  strain: number;
  /** 이번 프레임에 끊겼나 — 연출을 트리거하는 신호다. */
  breaking: boolean;
  magnet: MagnetState;
}

/**
 * 한 프레임의 상태를 계산한다.
 *
 * **순서가 뜻을 만든다**: 끊기 전에는 부모가 붙잡고(장력), 끊긴 뒤에야 자석이
 * 일한다. 둘을 동시에 켜면 부모에게서 멀어지는 중에 다른 카드가 잡아당겨
 * 어디로 가는지 알 수 없다.
 */
export function detachStep(inp: DetachInput): DetachState {
  const breakAt = inp.breakAt ?? BREAK_DIST;
  const d = Math.hypot(inp.dx, inp.dy);

  // 1) 아직 부모에게 매여 있다 — 뒤처지며 따라온다.
  if (inp.hasParent && !inp.broken) {
    if (d < breakAt) {
      return {
        offset: laggedDelta(inp.dx, inp.dy, breakAt),
        strain: strain(d, breakAt),
        breaking: false,
        magnet: NO_MAGNET,
      };
    }
    // 방금 끊겼다. 저항이 사라지므로 포인터로 튀어나간다.
    return {
      offset: { x: inp.dx, y: inp.dy },
      strain: 0,
      breaking: true,
      magnet: NO_MAGNET,
    };
  }

  // 2) 매인 데가 없다 — 자석이 일한다.
  const moved: Rect = {
    ...inp.rect,
    x: inp.rect.x + inp.dx,
    y: inp.rect.y + inp.dy,
  };
  const m = magnetFor(moved, inp.candidates, inp.blocked);
  return {
    offset: { x: inp.dx + m.pull.x, y: inp.dy + m.pull.y },
    strain: 0,
    breaking: false,
    magnet: m,
  };
}
