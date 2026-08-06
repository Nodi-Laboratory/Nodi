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
 * 260 → 150. "장력이 시작되고 끊길 때까지의 텀이 너무 길다"(사용자 2026-08-06).
 * 260은 카드 폭의 절반이라 **화면을 가로질러 끌어야** 끊겼다 — 떼어내려는
 * 의도는 첫 손짓에서 이미 분명한데 그걸 계속 확인시키는 셈이었다.
 *
 * 150이면 카드 높이 남짓이다. 자리를 조금 다듬는 것(수십 px)과는 여전히
 * 확실히 갈린다.
 */
export const BREAK_DIST = 150;

/**
 * 끊기기 직전에 카드가 뒤처지는 최대 비율.
 *
 * **두 번 조정한 값이다.** 0.38은 "저항이 안 느껴진다", 0.55는 "너무 세다"
 * (사용자 2026-08-05 → 08-06). 0.45면 끊기 직전에 115px쯤 뒤처진다 — 버티는
 * 것은 보이되 카드가 손에서 떨어져 나간 것처럼 보이지는 않는다.
 */
const LAG_MAX = 0.45;

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
 * 220 → 560 → 380 → 260. 마지막 조정은 **띠를 좁히기 위해서다**: "자석이
 * 시작되는 부분은 너무 빠른데 그 뒤로 연결되려면 더 가까이 붙어야 한다.
 * 이 사이의 텀을 줄여야 해"(사용자 2026-08-06).
 *
 * 걸리는 거리와 붙는 거리가 멀면 **끌려는 가는데 안 붙는 구간**이 길어진다 —
 * 학생 눈에는 "반응은 하는데 연결이 안 된다"이다. 지금은 260에서 걸려
 * 200에서 붙는다(띠 60px). 걸리면 곧 붙는다.
 */
export const MAGNET_DIST = 260;

/**
 * 붙는 간격. 여기까지 오면 연결선이 **팍** 생긴다.
 *
 * 자석 반경과 나눠 둔 이유는 "끌리는 구간"이 있어야 붙는 순간이 사건으로
 * 읽히기 때문이다. 하나로 두면 경계에서 붙었다 떨어졌다 깜박인다.
 *
 * 96 → 240 → 150 → 200. 자석 반경 바로 아래에 붙여 둔다 — **걸리는 순간과
 * 붙는 순간 사이를 짧게** 하려는 것이다(사용자 2026-08-06). 그래도 같은 값은
 * 아니다: 완전히 붙이면 경계에서 붙었다 떨어졌다 깜박인다.
 */
export const SNAP_DIST = 200;

/**
 * 자석이 카드를 부모 쪽으로 당기는 최대 거리(world px).
 *
 * 46 → 260 → 90. 260은 카드가 손에서 튀어나가듯 빨려 들어가 **어디로 가는지
 * 안 보였다**(사용자 2026-08-06: "너무 쎄"). 90px이면 포인터에서 눈에 띄게
 * 벗어나 부모 쪽으로 기울되, 카드가 여전히 손을 따라온다.
 */
const MAGNET_PULL = 90;

/**
 * 붙어도 **이만큼은 떨어뜨린다** (world px).
 *
 * 연결선은 두 상자의 변에서 각각 바깥으로 조금 밀어낸 점을 잇는다
 * (`connector.linkGeometry`). 그래서 간격이 좁아지면 두 끝점이 서로를
 * 지나쳐 **선이 거꾸로 흐르고**, 곡선이 카드 뒤에서 매듭이 되어 사라진다
 * (실측 2026-08-06: 간격 20에서 끝점이 시작점보다 위로 갔다).
 *
 * 학생 눈에는 **"가까이 갈수록 연결이 안 된다"**로 보인다 — 사용자 보고가
 * 정확히 그것이었다. 자석이 카드를 선이 그려질 수 없는 자리로 끌고 갔다.
 *
 * 그래서 자석은 여기까지만 당긴다. 학생이 손으로 더 붙이는 것은 막지 않는다
 * (밀어내면 손과 싸운다) — 그때는 대상 카드의 테두리가 대신 알린다.
 */
export const ATTACH_GAP = 96;

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
   * 비율(0.7)로 남기던 것을 **절대 거리**로 바꿨다. 비율은 간격이 좁아질수록
   * 남는 자리도 같이 좁아져서, 결국 연결선이 그려질 수 없는 데까지 끌고 간다.
   * 남겨야 할 것은 "간격의 몇 %"가 아니라 **선 하나가 들어갈 자리**다.
   */
  const amount = Math.min(MAGNET_PULL * grip, Math.max(0, bestGap - ATTACH_GAP));
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
