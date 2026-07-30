import type { Rect } from "./types";

export type { Rect };

/** 두 사각형이 겹치는가. 변이 닿기만 한 것은 겹침이 아니다. */
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/**
 * `outer`가 `inner`를 **완전히** 품는가.
 *
 * 올가미 선택의 판정이다. Excalidraw도 같은 규칙을 쓴다 — 실측으로 확인했다
 * (도형에 걸치기만 한 올가미는 선택하지 않고, 완전히 감싸야 선택한다).
 * 우리가 교차 판정을 쓰면 **같은 드래그가 글은 잡고 도형은 안 잡는다.**
 * 사용자가 요구한 "함께 묶이도록"이 정확히 그 지점에서 깨진다.
 */
export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
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
