/**
 * 사각형 판정 — 특히 `contains`.
 *
 * 올가미 선택이 이 함수 위에 서 있고, **Excalidraw와 규칙이 같아야 한다.**
 * 실측(2026-07-31): 도형에 걸치기만 한 올가미는 Excalidraw가 선택하지 않고,
 * 완전히 감싸야 선택한다. 우리가 교차 판정으로 되돌아가면 같은 드래그가 글은
 * 잡고 도형은 놓치는 상태가 된다.
 */

import { describe, expect, it } from "vitest";
import { contains, intersects, union } from "./rect";
import type { Rect } from "./rect";

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe("contains — 완전 포함", () => {
  const outer = r(0, 0, 100, 100);

  it("완전히 안에 있으면 참", () => {
    expect(contains(outer, r(10, 10, 50, 50))).toBe(true);
  });

  it("변이 정확히 맞닿아도 참(경계 포함)", () => {
    expect(contains(outer, r(0, 0, 100, 100))).toBe(true);
  });

  it("한 귀퉁이만 걸치면 거짓 — 교차와 갈리는 지점", () => {
    const partial = r(80, 80, 50, 50);
    expect(intersects(outer, partial)).toBe(true);
    expect(contains(outer, partial)).toBe(false);
  });

  it("바깥으로 1px만 삐져나가도 거짓", () => {
    expect(contains(outer, r(0, 0, 101, 100))).toBe(false);
    expect(contains(outer, r(-1, 0, 100, 100))).toBe(false);
    expect(contains(outer, r(0, 0, 100, 101))).toBe(false);
    expect(contains(outer, r(0, -1, 100, 100))).toBe(false);
  });

  it("완전히 떨어져 있으면 거짓", () => {
    expect(contains(outer, r(500, 500, 10, 10))).toBe(false);
  });

  it("작은 것이 큰 것을 품을 수는 없다(순서가 의미를 가진다)", () => {
    const small = r(10, 10, 5, 5);
    expect(contains(outer, small)).toBe(true);
    expect(contains(small, outer)).toBe(false);
  });
});

describe("union", () => {
  it("비었으면 null", () => {
    expect(union([])).toBeNull();
  });

  it("전부를 감싸고, 감싼 결과는 각 원소를 품는다", () => {
    const rects = [r(0, 0, 10, 10), r(-30, 5, 10, 40), r(100, -20, 5, 5)];
    const u = union(rects)!;
    for (const x of rects) expect(contains(u, x)).toBe(true);
    expect(u).toEqual({ x: -30, y: -20, w: 135, h: 65 });
  });
});
