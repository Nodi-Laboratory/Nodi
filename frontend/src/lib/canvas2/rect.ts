import type { Rect } from "./types";

export type { Rect };

/** 두 사각형이 겹치는가. 변이 닿기만 한 것은 겹침이 아니다. */
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/** 사방으로 pad만큼 부풀린다. */
export function inflate(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

export function bottom(r: Rect): number {
  return r.y + r.h;
}

export function right(r: Rect): number {
  return r.x + r.w;
}

/** `inner`가 `outer` 안에 온전히 들어가는가. 변이 닿는 것은 들어간 것으로 본다. */
export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** 여러 사각형을 감싸는 최소 사각형. 비었으면 null. */
export function union(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
