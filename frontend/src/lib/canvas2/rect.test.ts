/**
 * 사각형 판정.
 *
 * 올가미 선택이 `intersects` 위에 서 있다 — 사용자 지시(2026-07-31)로 "요소의
 * 일부만 들어가도 선택"이 규칙이다.
 */

import { describe, expect, it } from "vitest";
import { intersects, union } from "./rect";
import type { Rect } from "./rect";

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe("union", () => {
  it("비었으면 null", () => {
    expect(union([])).toBeNull();
  });

  it("전부를 감싸고, 감싼 결과는 각 원소를 품는다", () => {
    const rects = [r(0, 0, 10, 10), r(-30, 5, 10, 40), r(100, -20, 5, 5)];
    const u = union(rects)!;
    for (const x of rects) expect(intersects(u, x)).toBe(true);
    expect(u).toEqual({ x: -30, y: -20, w: 135, h: 65 });
  });
});
