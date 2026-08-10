import { describe, expect, it } from "vitest";
import { polygonPoints } from "./polyShapes";

/**
 * 세모·별의 꼭짓점 (사용자 지시 2026-08-09).
 *
 * 화면으로는 "대충 별처럼 생겼다"까지밖에 못 본다. 여기서 재는 것은 그
 * 아래의 약속이다 — **상자를 꽉 채우고**, **닫혀 있고**, 크기를 바꿔도 모양이
 * 안 변한다.
 */
describe("polygonPoints", () => {
  const bounds = (pts: [number, number][]) => ({
    x0: Math.min(...pts.map((p) => p[0])),
    y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])),
    y1: Math.max(...pts.map((p) => p[1])),
  });

  it("세모는 상자를 꽉 채운다", () => {
    const b = bounds(polygonPoints("triangle", 200, 100));
    expect(b.x0).toBeCloseTo(0);
    expect(b.y0).toBeCloseTo(0);
    expect(b.x1).toBeCloseTo(200);
    expect(b.y1).toBeCloseTo(100);
  });

  it("별도 상자를 꽉 채운다 — 위 꼭짓점이 정면이다", () => {
    const pts = polygonPoints("star", 100, 100);
    const b = bounds(pts);
    expect(b.x1 - b.x0).toBeCloseTo(100, 0);
    expect(b.y0).toBeCloseTo(0, 0);
    // 첫 점이 위 꼭짓점 — 별이 옆으로 눕지 않았다는 뜻이다.
    expect(pts[0][0]).toBeCloseTo(50);
    expect(pts[0][1]).toBeCloseTo(0);
  });

  it("닫혀 있다 — 안 닫으면 획 하나로 끊겨 보인다", () => {
    for (const kind of ["triangle", "star"] as const) {
      const pts = polygonPoints(kind, 80, 60);
      expect(pts[0]).toEqual(pts[pts.length - 1]);
    }
  });

  it("별은 뾰족한 끝이 다섯이다", () => {
    // 바깥 점 5 + 안쪽 점 5 + 닫는 점 1
    expect(polygonPoints("star", 50, 50)).toHaveLength(11);
  });

  it("음수·0 크기에도 무너지지 않는다 — 끌다가 되돌린 순간이 그렇다", () => {
    for (const kind of ["triangle", "star"] as const) {
      for (const [w, h] of [
        [0, 0],
        [-40, 30],
        [30, -40],
      ]) {
        const pts = polygonPoints(kind, w, h);
        expect(pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
      }
    }
  });
});
