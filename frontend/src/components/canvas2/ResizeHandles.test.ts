import { describe, expect, it } from "vitest";
import { requestedSize } from "./ResizeHandles";

const start = { w: 300, h: 200 };

describe("requestedSize — 가로·세로 독립", () => {
  it("동쪽 손잡이는 폭만 늘린다", () => {
    expect(requestedSize("e", 40, 0, start)).toEqual({ w: 340, h: 200 });
  });
  it("서쪽 손잡이는 폭을 반대로 바꾼다", () => {
    expect(requestedSize("w", 40, 0, start)).toEqual({ w: 260, h: 200 });
  });
  it("남쪽 손잡이는 높이만 늘린다", () => {
    expect(requestedSize("s", 0, 30, start)).toEqual({ w: 300, h: 230 });
  });
  it("북쪽 손잡이는 높이를 반대로 바꾼다", () => {
    expect(requestedSize("n", 0, 30, start)).toEqual({ w: 300, h: 170 });
  });
  it("대각(se) 손잡이는 폭과 높이를 모두 바꾼다", () => {
    expect(requestedSize("se", 40, 30, start)).toEqual({ w: 340, h: 230 });
  });
  it("대각(nw) 손잡이는 폭·높이를 반대로 바꾼다", () => {
    expect(requestedSize("nw", 40, 30, start)).toEqual({ w: 260, h: 170 });
  });
});
