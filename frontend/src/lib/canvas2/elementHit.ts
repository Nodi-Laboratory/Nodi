/**
 * 올가미가 도형에 **실제로 닿았는가** (D141).
 *
 * ## 바운딩 박스로는 안 된다
 *
 * 예전에는 사각형 교차만 봤다. 그러면 속이 빈 도형의 **가운데 빈 곳**이나
 * 대각선의 빈 모서리를 끌어도 잡힌다 — 사용자 지적: "직접적으로 그 요소의
 * 몸체를 선택하지 않고 배경 부분을 선택했는데 바운딩 박스 안이라 선택됐다."
 *
 * 대각선 하나만 봐도 분명하다. 왼쪽 위 ↘ 오른쪽 아래로 그은 선의 바운딩
 * 박스는 정사각형이고, 그 **오른쪽 위 절반은 잉크가 전혀 없다.**
 *
 *     ┌───────┐
 *     │╲      │   ← 여기를 끌어도 예전에는 선이 잡혔다
 *     │  ╲    │
 *     │    ╲  │
 *     └───────┘
 *
 * ## 어떻게 판정하나
 *
 * 요소마다 **잉크가 지나는 선분들**을 만들어 올가미와 교차하는지 본다.
 *
 *     freedraw·line·arrow   점들을 이은 선분
 *     rectangle             네 변
 *     diamond               마름모 네 변
 *     ellipse               다각형 근사(24각형)
 *     그 외(text·image 등)   덩어리이므로 바운딩 박스 그대로
 *
 * **배경색이 채워져 있으면 속도 몸이다** — 그때는 박스로 본다.
 *
 * 회전(`angle`)은 각 점을 요소 중심 기준으로 돌려서 반영한다.
 */

import type { Rect } from "./rect";
import { intersects } from "./rect";

export interface HitElement {
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 라디안. 없으면 0. */
  angle?: number;
  /** 선형 요소의 점들(요소 x,y 기준 상대 좌표). */
  points?: readonly (readonly number[])[];
  /** "transparent"면 속이 비었다. */
  backgroundColor?: string;
}

export interface Pt {
  x: number;
  y: number;
}

/** 타원 근사 각 수. 24면 반지름 100px에서 오차가 1px 아래다. */
const ELLIPSE_STEPS = 24;

/** 채워진 도형인가. 비었으면 테두리만 몸이다. */
function isFilled(el: HitElement): boolean {
  const bg = (el.backgroundColor ?? "transparent").trim().toLowerCase();
  return bg !== "" && bg !== "transparent" && bg !== "none";
}

/** 음수 폭/높이(역방향으로 그린 도형)를 정규화한 사각형. */
export function boundsOf(el: HitElement): Rect {
  return {
    x: el.width < 0 ? el.x + el.width : el.x,
    y: el.height < 0 ? el.y + el.height : el.y,
    w: Math.abs(el.width),
    h: Math.abs(el.height),
  };
}

/** 요소 중심을 축으로 회전. Excalidraw의 angle 규약과 같다. */
function rotate(p: Pt, center: Pt, angle: number): Pt {
  if (!angle) return p;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
}

/**
 * 잉크가 지나는 선분들(world 좌표). 덩어리 요소면 null —
 * 호출부가 바운딩 박스로 판정한다.
 */
export function inkSegments(el: HitElement): [Pt, Pt][] | null {
  const b = boundsOf(el);
  const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const a = el.angle ?? 0;
  const R = (p: Pt) => rotate(p, center, a);
  const type = el.type ?? "";

  if (el.points && el.points.length >= 2) {
    // 선형 요소 — 점은 요소 원점 기준 상대 좌표다.
    const pts = el.points.map((p) => R({ x: el.x + (p[0] ?? 0), y: el.y + (p[1] ?? 0) }));
    const segs: [Pt, Pt][] = [];
    for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
    return segs;
  }

  if (isFilled(el)) return null; // 속까지 몸이다

  const corners = (ps: Pt[]): [Pt, Pt][] => {
    const r = ps.map(R);
    const out: [Pt, Pt][] = [];
    for (let i = 0; i < r.length; i++) out.push([r[i], r[(i + 1) % r.length]]);
    return out;
  };

  if (type === "rectangle" || type === "frame" || type === "magicframe") {
    return corners([
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h },
    ]);
  }

  if (type === "diamond") {
    return corners([
      { x: b.x + b.w / 2, y: b.y },
      { x: b.x + b.w, y: b.y + b.h / 2 },
      { x: b.x + b.w / 2, y: b.y + b.h },
      { x: b.x, y: b.y + b.h / 2 },
    ]);
  }

  if (type === "ellipse") {
    const ps: Pt[] = [];
    for (let i = 0; i < ELLIPSE_STEPS; i++) {
      const t = (i / ELLIPSE_STEPS) * Math.PI * 2;
      ps.push({
        x: center.x + (b.w / 2) * Math.cos(t),
        y: center.y + (b.h / 2) * Math.sin(t),
      });
    }
    return corners(ps);
  }

  // text·image·embeddable 등은 글자·그림이 박스를 채운다.
  return null;
}

function inRect(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** 두 선분이 만나는가(끝점 접촉 포함). */
function segsCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
  // 일직선상에 겹쳐 놓인 경우
  const on = (p: Pt, q: Pt, r: Pt) =>
    Math.abs(d(p, q, r)) < 1e-9 &&
    Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) &&
    Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  return on(b1, b2, a1) || on(b1, b2, a2) || on(a1, a2, b1) || on(a1, a2, b2);
}

/** 선분이 사각형에 닿는가 — 안에 있거나 변을 지나면 참. */
export function segmentHitsRect(p: Pt, q: Pt, r: Rect): boolean {
  if (inRect(p, r) || inRect(q, r)) return true;
  const c: Pt[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) {
    if (segsCross(p, q, c[i], c[(i + 1) % 4])) return true;
  }
  return false;
}

/**
 * 올가미 `rect`가 이 요소의 **몸**에 닿았는가.
 *
 * 올가미가 요소를 통째로 감쌌으면 잉크를 따질 것 없이 참이다 — 감쌌는데 안
 * 잡히면 그게 더 이상하다.
 */
export function elementHitsRect(el: HitElement, rect: Rect): boolean {
  const segs = inkSegments(el);

  /**
   * 빠른 탈출·감쌈 판정에 쓰는 사각형.
   *
   * **회전한 요소는 `x,y,width,height` 밖으로 잉크가 나간다.** Excalidraw의
   * 그 값들은 돌리기 **전**의 박스라, 45° 돌린 정사각형은 꼭짓점이 위아래로
   * 20% 남짓 튀어나온다. 그 박스로 걸러 내면 정작 잉크가 있는 자리를 놓친다
   * (이 함수의 첫 버전이 그랬고, 회전 테스트가 잡았다).
   *
   * 잉크 선분이 있으면 그 선분들의 범위를, 없으면(덩어리) 박스를 쓴다.
   */
  const hull = segs?.length ? boundsOfPoints(segs.flat()) : boundsOf(el);

  // 범위조차 안 겹치면 볼 것도 없다.
  if (!intersects(rect, hull)) return false;
  // 통째로 감쌌으면 잉크를 따질 것 없이 잡는다.
  if (
    hull.x >= rect.x &&
    hull.y >= rect.y &&
    hull.x + hull.w <= rect.x + rect.w &&
    hull.y + hull.h <= rect.y + rect.h
  ) {
    return true;
  }
  if (!segs) return true; // 덩어리 요소 — 박스 교차로 충분하다
  return segs.some(([p, q]) => segmentHitsRect(p, q, rect));
}

/** 점들을 감싸는 사각형. */
function boundsOfPoints(pts: readonly Pt[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
