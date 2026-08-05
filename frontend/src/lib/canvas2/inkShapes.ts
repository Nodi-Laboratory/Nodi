/**
 * 표시의 **모양**을 읽는다 (D178).
 *
 * ## 왜 파일을 나눴나
 *
 * `inkScene`이 하는 일은 **어느 카드를 보낼까**다. 이 파일이 하는 일은 **학생이
 * 무엇을 그렸나**다. 처음에는 한 함수(`markOf`)가 둘을 같이 했는데, 그 함수는
 * 카드마다 다시 불리므로 **획의 성질을 카드 수만큼 다시 계산**했다. 획의 모양은
 * 카드와 무관한 값이다 — 한 번 재고 끝나야 한다.
 *
 * ## 획 하나 = 표시 하나가 아니다
 *
 * 사람은 화살표를 **몸통 긋고 촉을 따로 그린다.** 동그라미도 한 번에 못 그리면
 * 두 번에 나눠 그린다. 획 단위로 판정하면 이 둘이 통째로 무너진다 — 촉만 남은
 * 짧은 획이 엉뚱한 카드를 짚고, 반쪽 원은 아무것도 감싸지 못한다.
 *
 * 그래서 **끝이 서로 닿는 획들을 하나로 묶어**(`groupStrokes`) 그 묶음을 표시
 * 하나로 읽는다. 묶는 기준이 "가까움"이 아니라 "끝이 닿음"인 이유는, 가까움으로
 * 묶으면 나란히 그린 별개의 표시 둘이 한 덩어리가 되기 때문이다.
 *
 * ## 감쌈은 bbox로 재지 않는다
 *
 * 원래는 "획 bbox가 카드 넓이의 70%를 덮으면 감쌈"이었다. 그러면 **비스듬한
 * 직선 하나가 동그라미가 된다** — 대각선의 bbox는 커다란 직사각형이다. 지금은
 * 획을 다각형으로 닫고 카드 위 격자점이 그 안에 드는 비율을 센다
 * (`enclosureRatio`). 타원·찌그러진 원·여러 카드를 한 번에 감싼 큰 원이 모두
 * 같은 규칙으로 풀린다.
 */

import type { PenStroke } from "./penPad";
import type { Rect } from "./rect";

export interface Pt {
  x: number;
  y: number;
}

/* ────────────────────────── 원시 기하 ────────────────────────── */

/** 점이 사각형 안에 있나(변 포함). */
export function inside(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 두 사각형 사이 최단 거리. 겹치면 0. */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

/**
 * 두 사각형이 겹치는 넓이. 안 겹치면 0.
 *
 * 도판이 둘 이상 표시에 닿았을 때 **어느 것을 확대해 보낼지** 고르는 잣대다.
 */
export function rectOverlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 점에서 사각형까지 최단 거리. 안에 있으면 0. */
export function pointGap(p: Pt, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** 두 선분이 만나나. */
function segCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  // 평행·공선은 잡지 않는다 — 변을 따라 스치는 것은 접촉이 아니다.
  if (d === 0) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * 선분이 사각형에 닿나 — 안에서 끝나는 경우와 관통하는 경우 둘 다.
 *
 * **bbox로 재면 안 된다.** 대각선 화살표의 bbox는 커다란 직사각형이라,
 * 화살표가 지나가지도 않은 양쪽 구석의 카드가 접촉으로 잡힌다. 그러면 질문에
 * 엉뚱한 카드가 딸려 가고, SOLAR는 그것까지 설명한다.
 */
export function segmentHitsRect(
  ax: number, ay: number, bx: number, by: number, r: Rect,
): boolean {
  if (inside(ax, ay, r) || inside(bx, by, r)) return true;
  const x1 = r.x;
  const y1 = r.y;
  const x2 = r.x + r.w;
  const y2 = r.y + r.h;
  return (
    segCross(ax, ay, bx, by, x1, y1, x2, y1) ||
    segCross(ax, ay, bx, by, x2, y1, x2, y2) ||
    segCross(ax, ay, bx, by, x2, y2, x1, y2) ||
    segCross(ax, ay, bx, by, x1, y2, x1, y1)
  );
}

/**
 * 점이 다각형 안에 있나 — 홀짝 광선법. **다각형은 닫힌 것으로 친다**(마지막
 * 점과 첫 점을 잇는다). 학생이 그린 원은 끝이 딱 안 맞으므로 우리가 닫는다.
 */
export function pointInPoly(poly: readonly Pt[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    ) {
      hit = !hit;
    }
  }
  return hit;
}

/** 감쌈을 재는 격자 조밀도. 5×5 = 25점이면 반쯤 걸친 것과 감싼 것이 갈린다. */
const GRID = 5;

/**
 * 이 다각형이 사각형을 얼마나 감쌌나(0~1).
 *
 * 카드 위에 고르게 뿌린 격자점 중 다각형 안에 드는 비율이다. **넓이 비가 아니라
 * 표본 비**인 이유는 학생이 그린 고리가 볼록하지도 단순하지도 않기 때문이다 —
 * 자기 자신을 두 번 감는 원도 홀짝 규칙으로 자연스럽게 풀린다.
 */
export function enclosureRatio(poly: readonly Pt[], r: Rect): number {
  if (poly.length < 3) return 0;
  let n = 0;
  for (let i = 0; i < GRID; i++) {
    const x = r.x + (r.w * (i + 0.5)) / GRID;
    for (let j = 0; j < GRID; j++) {
      const y = r.y + (r.h * (j + 0.5)) / GRID;
      if (pointInPoly(poly, x, y)) n++;
    }
  }
  return n / (GRID * GRID);
}

/* ────────────────────────── 획 한 번 재기 ────────────────────────── */

/**
 * 획 하나의 미리 잰 값.
 *
 * **카드마다 다시 재지 않기 위해 존재한다.** 예전 `markOf`는 카드 하나를 볼
 * 때마다 획의 bbox와 길이를 다시 계산했다 — 카드 8장 × 획 30개면 같은 값을
 * 240번 잰다. 여기서 한 번 재고 아래 전부가 이 값을 쓴다.
 */
export interface StrokeInfo {
  pts: PenStroke;
  box: Rect;
  /** 경로 길이(획을 따라간 거리). */
  len: number;
  /** 시작점 → 끝점 직선 거리. `len`과의 비가 곧은 정도다. */
  span: number;
  a: Pt;
  z: Pt;
}

export function measureStroke(s: PenStroke): StrokeInfo | null {
  if (!s.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const p = s[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (i > 0) len += Math.hypot(p.x - s[i - 1].x, p.y - s[i - 1].y);
  }
  const a = s[0];
  const z = s[s.length - 1];
  return {
    pts: s,
    box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    len,
    span: Math.hypot(z.x - a.x, z.y - a.y),
    a: { x: a.x, y: a.y },
    z: { x: z.x, y: z.y },
  };
}

export function measureStrokes(strokes: readonly PenStroke[]): StrokeInfo[] {
  const out: StrokeInfo[] = [];
  for (const s of strokes) {
    const m = measureStroke(s);
    if (m) out.push(m);
  }
  return out;
}

/** 획의 bbox 대각선 — "이 획이 얼마나 큰가"의 잣대. */
export function strokeSize(s: StrokeInfo): number {
  return Math.hypot(s.box.w, s.box.h);
}

/**
 * 이 획이 사각형에 닿나.
 *
 * **bbox로 먼저 쳐낸다** — 획 하나가 수백 점이라 카드마다 전 구간을 훑으면
 * 그만큼이 그대로 곱해진다. 대부분의 카드는 획 근처에도 없다.
 */
export function strokeHitsRect(s: StrokeInfo, r: Rect): boolean {
  if (rectGap(s.box, r) > 0) return false;
  const pts = s.pts;
  if (pts.length === 1) return inside(pts[0].x, pts[0].y, r);
  for (let i = 1; i < pts.length; i++) {
    if (segmentHitsRect(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, r)) {
      return true;
    }
  }
  return false;
}

/* ────────────────────────── 획 묶기 ────────────────────────── */

/** 점에서 선분까지 최단 거리. */
function distPointSeg(p: Pt, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const d2 = dx * dx + dy * dy;
  if (d2 === 0) return Math.hypot(p.x - ax, p.y - ay);
  let t = ((p.x - ax) * dx + (p.y - ay) * dy) / d2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy));
}

/** 점에서 획까지 최단 거리. `limit`을 넘는 것이 확실하면 일찍 포기한다. */
function distToStroke(p: Pt, s: StrokeInfo, limit: number): number {
  if (pointGap(p, s.box) > limit) return Infinity;
  const pts = s.pts;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distPointSeg(p, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
    if (d < best) {
      best = d;
      if (best <= limit) return best;
    }
  }
  return best;
}

/**
 * 두 획이 **끝에서 닿나.**
 *
 * "가까움"이 아니라 "끝이 닿음"이다. 가까움으로 보면 나란히 그린 별개의 표시
 * 둘이 한 덩어리가 된다. 사람이 표시를 나눠 그릴 때는 언제나 앞 획이 끝난
 * 자리에서 다음 획을 시작한다 — 화살표의 촉도, 반쪽씩 그린 원도 그렇다.
 */
export function strokesTouch(a: StrokeInfo, b: StrokeInfo, gap: number): boolean {
  if (rectGap(a.box, b.box) > gap) return false;
  return (
    distToStroke(a.a, b, gap) <= gap ||
    distToStroke(a.z, b, gap) <= gap ||
    distToStroke(b.a, a, gap) <= gap ||
    distToStroke(b.z, a, gap) <= gap
  );
}

/** 끝이 서로 닿는 획들을 묶는다 (`strokesTouch` 기준). */
export function groupStrokes(
  infos: readonly StrokeInfo[],
  joinGap: number,
): StrokeInfo[][] {
  const parent = infos.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };

  for (let i = 0; i < infos.length; i++) {
    for (let j = i + 1; j < infos.length; j++) {
      if (!strokesTouch(infos[i], infos[j], joinGap)) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent[ra] = rb;
    }
  }

  const bins = new Map<number, StrokeInfo[]>();
  for (let i = 0; i < infos.length; i++) {
    const r = find(i);
    const bin = bins.get(r);
    if (bin) bin.push(infos[i]);
    else bins.set(r, [infos[i]]);
  }
  return [...bins.values()];
}

/* ────────────────────────── 모양 읽기 ────────────────────────── */

export type GestureShape =
  /** 닫힌 고리 — 감싼다. */
  | "circle"
  /** 화살촉이 달린 선 — **방향이 있다.** */
  | "arrow"
  /** 곧고 가로로 누운 선 — 밑줄. */
  | "underline"
  /** 그 밖의 선(직선·완만한 곡선). 둘을 이을 수도, 하나를 짚을 수도 있다. */
  | "line"
  /** 모서리가 둘 이상인 꺾인 선 — ㄷ·[ 처럼 여럿을 묶는다. */
  | "bracket"
  /** 여러 번 왔다 갔다 한 선 — 덧칠·강조. */
  | "scribble";

export interface Gesture {
  /** 이 표시를 이루는 획들. */
  strokes: StrokeInfo[];
  shape: GestureShape;
  box: Rect;
  /** 감쌈 판정용 다각형(닫아서 쓴다). */
  poly: Pt[];
  closed: boolean;
  /**
   * 화살촉·선 끝이 멈춘 자리 — **가리킨 곳.** 닫힌 고리는 null.
   *
   * 한 획 화살표에서는 마지막 점이 아니다. 촉을 그리느라 되꺾이므로 마지막
   * 점은 촉의 꼬리에 있다 — 진행 방향으로 가장 멀리 나간 점이 촉이다.
   */
  tip: Pt | null;
  /** 출발한 자리. 닫힌 고리는 null. */
  tail: Pt | null;
  len: number;
}

/** 길이를 따라 고르게 n점을 다시 뽑는다 — 모양 판정을 점 밀도와 무관하게 만든다. */
function resample(pts: readonly Pt[], n: number): Pt[] {
  if (pts.length < 2) return [...pts];
  let total = 0;
  const seg: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    seg.push(d);
    total += d;
  }
  if (total === 0) return [pts[0]];
  const out: Pt[] = [pts[0]];
  const step = total / (n - 1);
  let i = 1;
  let walked = 0;
  for (let k = 1; k < n - 1; k++) {
    const want = step * k;
    while (i < pts.length && walked + seg[i - 1] < want) {
      walked += seg[i - 1];
      i++;
    }
    if (i >= pts.length) break;
    const t = seg[i - 1] > 0 ? (want - walked) / seg[i - 1] : 0;
    out.push({
      x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
      y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
    });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** 꺾임 개수(60° 넘는 방향 전환)와 총 회전량(라디안). */
function turning(pts: readonly Pt[]): { corners: number; total: number } {
  const s = resample(pts, 17);
  let corners = 0;
  let total = 0;
  let px = 0;
  let py = 0;
  let has = false;
  for (let i = 1; i < s.length; i++) {
    const dx = s[i].x - s[i - 1].x;
    const dy = s[i].y - s[i - 1].y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    const ux = dx / d;
    const uy = dy / d;
    if (has) {
      const dot = Math.max(-1, Math.min(1, px * ux + py * uy));
      const ang = Math.acos(dot);
      total += ang;
      if (ang > Math.PI / 3) corners++;
    }
    px = ux;
    py = uy;
    has = true;
  }
  return { corners, total };
}

/**
 * 한 획으로 그린 화살표의 촉을 찾는다. 촉이 없으면 null.
 *
 * 판정은 **끝난 자리보다 더 멀리 갔었나**다. 화살촉을 그리려면 촉까지 갔다가
 * 날개를 그리러 되돌아 나와야 하므로, 진행 방향으로 가장 멀리 나간 점이
 * 마지막 점보다 앞선다. 그냥 그은 선·꺾인 선·지그재그에서는 마지막 점이 곧
 * 가장 먼 점이라 이 차이가 0이다.
 *
 * ⚠️ "마지막 구간의 방향이 전체 방향과 등지나"로 재면 **못 잡는다.** 날개가
 * 둘이면 그 둘이 서로를 상쇄한다(위 날개 + 아래 날개 = 합이 앞쪽). 실측
 * 2026-08-05: 전형적인 한 획 화살표가 그 규칙으로는 통째로 안 잡혔다.
 */
function arrowTip(pts: readonly Pt[], len: number): Pt | null {
  if (pts.length < 3 || len <= 0) return null;
  const a = pts[0];
  const z = pts[pts.length - 1];
  const d = Math.hypot(z.x - a.x, z.y - a.y);
  if (d < 1) return null;
  const ux = (z.x - a.x) / d;
  const uy = (z.y - a.y) / d;

  let best = z;
  let bestProj = -Infinity;
  for (const p of pts) {
    const proj = (p.x - a.x) * ux + (p.y - a.y) * uy;
    if (proj > bestProj) {
      bestProj = proj;
      best = p;
    }
  }
  // 끝점의 투영은 정의상 d다 — 그보다 얼마나 더 갔었나가 촉의 크기다.
  return bestProj - d > Math.max(4, len * 0.05) ? best : null;
}

/**
 * 획들을 끝끼리 이어 하나의 경로로 편다 — 감쌈 판정에 쓸 다각형.
 *
 * `contiguous`는 **이음매가 전부 붙어 있었나**다. 이 값이 없으면 화살표가
 * 동그라미로 둔갑한다: 몸통 뒤에 날개 둘을 이어 붙이면 경로의 끝이 시작
 * 근처로 돌아오기 때문이다(실측 2026-08-05 — 몸통을 오른쪽에서 왼쪽으로 긋고
 * 촉을 오른쪽에 단 화살표가 닫힌 고리로 잡혔다). 진짜 고리는 이음매가 붙어
 * 있고, 가지를 친 표시는 그 자리에서 건너뛴다.
 */
function chain(
  group: readonly StrokeInfo[],
  joinGap: number,
): { poly: Pt[]; contiguous: boolean } {
  if (group.length === 1) {
    return { poly: group[0].pts.map((p) => ({ x: p.x, y: p.y })), contiguous: true };
  }
  const left = [...group];
  // 가장 긴 획에서 시작한다 — 몸통이 경로의 뼈대여야 곁가지가 순서를 흔들지 않는다.
  left.sort((a, b) => b.len - a.len);
  const first = left.shift()!;
  const out: Pt[] = first.pts.map((p) => ({ x: p.x, y: p.y }));
  let contiguous = true;
  while (left.length) {
    const end = out[out.length - 1];
    let bestI = 0;
    let bestD = Infinity;
    let flip = false;
    left.forEach((s, i) => {
      const da = Math.hypot(s.a.x - end.x, s.a.y - end.y);
      const dz = Math.hypot(s.z.x - end.x, s.z.y - end.y);
      const d = Math.min(da, dz);
      if (d < bestD) {
        bestD = d;
        bestI = i;
        flip = dz < da;
      }
    });
    if (bestD > joinGap * 1.5) contiguous = false;
    const s = left.splice(bestI, 1)[0];
    const pts = s.pts.map((p) => ({ x: p.x, y: p.y }));
    if (flip) pts.reverse();
    out.push(...pts);
  }
  return { poly: out, contiguous };
}

export interface GestureOpts {
  /** 획을 한 표시로 묶을 거리. */
  joinGap: number;
}

/** 획 묶음 하나 → 표시 하나. */
export function analyzeGesture(
  group: readonly StrokeInfo[],
  opts: GestureOpts,
): Gesture {
  const strokes = [...group].sort((a, b) => b.len - a.len);
  const main = strokes[0];
  const len = strokes.reduce((s, x) => s + x.len, 0);

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of strokes) {
    x0 = Math.min(x0, s.box.x);
    y0 = Math.min(y0, s.box.y);
    x1 = Math.max(x1, s.box.x + s.box.w);
    y1 = Math.max(y1, s.box.y + s.box.h);
  }
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

  const { poly, contiguous } = chain(strokes, opts.joinGap);
  const head = poly[0];
  const tailPt = poly[poly.length - 1];
  /**
   * 닫혔나 — 이은 경로의 처음과 끝이 거의 같은 자리인가.
   *
   * 비율로 재는 이유는 크기와 무관해야 하기 때문이다. C자 반원은 0.25쯤이라
   * 걸러지고, 조금 벌어진 동그라미는 통과한다.
   */
  const closeSpan = Math.hypot(tailPt.x - head.x, tailPt.y - head.y);
  const closed =
    contiguous && len > 0 && closeSpan <= Math.max(opts.joinGap, len * 0.22);

  /**
   * 몸통에 붙은 짧은 획들은 **화살촉**이다.
   *
   * 사람은 화살표를 몸통 긋고 촉을 따로 그린다. 촉이 붙은 쪽 끝이 가리킨
   * 방향이다 — 몸통을 어느 쪽에서부터 그었든 상관없다.
   */
  const heads = strokes.slice(1).filter((s) => s.len < main.len * 0.45);

  let tip: Pt | null = null;
  let tail: Pt | null = null;
  let hasArrow = false;
  if (!closed) {
    if (heads.length) {
      let cx = 0;
      let cy = 0;
      for (const h of heads) {
        cx += h.box.x + h.box.w / 2;
        cy += h.box.y + h.box.h / 2;
      }
      cx /= heads.length;
      cy /= heads.length;
      const toA = Math.hypot(main.a.x - cx, main.a.y - cy);
      const toZ = Math.hypot(main.z.x - cx, main.z.y - cy);
      tip = toA < toZ ? main.a : main.z;
      tail = toA < toZ ? main.z : main.a;
      hasArrow = true;
    } else {
      const hook = arrowTip(main.pts, main.len);
      hasArrow = hook !== null;
      tip = hook ?? main.z;
      tail = main.a;
    }
  }

  return {
    strokes,
    shape: shapeOf(main, closed, hasArrow),
    box,
    poly,
    closed,
    tip,
    tail,
    len,
  };
}

function shapeOf(main: StrokeInfo, closed: boolean, hasArrow: boolean): GestureShape {
  if (closed) return "circle";
  if (hasArrow) return "arrow";
  const { corners, total } = turning(main.pts);
  // 총 회전량이 한 바퀴(2π)에 가까우면 여러 번 왔다 갔다 한 것 — 덧칠이다.
  if (total > 5.5) return "scribble";
  if (corners >= 2) return "bracket";
  const straight = main.len > 0 && main.span >= main.len * 0.8;
  if (straight && Math.abs(main.z.y - main.a.y) <= Math.abs(main.z.x - main.a.x) * 0.35) {
    return "underline";
  }
  return "line";
}

/** 획들 → 표시들. 묶고 나서 각각을 읽는다. */
export function readGestures(
  infos: readonly StrokeInfo[],
  opts: GestureOpts,
): Gesture[] {
  return groupStrokes(infos, opts.joinGap).map((g) => analyzeGesture(g, opts));
}
