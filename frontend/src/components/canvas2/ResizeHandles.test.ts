import { describe, expect, it } from "vitest";
import { requestedSize } from "./ResizeHandles";

const start = { w: 300, h: 200 }; // aspect 1.5

describe("requestedSize — 자유 크기(aspect 없음)", () => {
  it("동쪽 손잡이는 폭만 늘린다", () => {
    expect(requestedSize("e", 40, 0, start)).toEqual({ w: 340, h: 200 });
  });
  it("서쪽 손잡이는 폭을 반대로 바꾼다", () => {
    expect(requestedSize("w", 40, 0, start)).toEqual({ w: 260, h: 200 });
  });
  it("남쪽 손잡이는 높이만 늘린다", () => {
    expect(requestedSize("s", 0, 30, start)).toEqual({ w: 300, h: 230 });
  });
});

describe("requestedSize — 비율 고정(aspect=1.5)", () => {
  it("동쪽으로 늘려도 높이가 비율을 따른다", () => {
    const r = requestedSize("e", 60, 0, start, 1.5);
    expect(r.w).toBe(360);
    expect(r.h).toBeCloseTo(240, 5); // 360 / 1.5
  });
  it("남쪽(세로 손잡이)으로 늘리면 폭이 비율을 따른다", () => {
    const r = requestedSize("s", 0, 40, start, 1.5);
    expect(r.h).toBe(240);
    expect(r.w).toBeCloseTo(360, 5); // 240 * 1.5
  });
  it("대각(se) 손잡이는 폭을 몰이축으로 삼아 비율을 지킨다", () => {
    const r = requestedSize("se", 60, 5, start, 1.5);
    expect(r.w).toBe(360);
    expect(r.h).toBeCloseTo(240, 5);
  });
});
