/** 자료를 놓을 빈 자리 (D210 7-1 C). */

import { describe, expect, it } from "vitest";
import { dropSpots, type Rect } from "./dropSpot";

const SIZE = { w: 300, h: 200 };
const 가운데 = { x: 1000, y: 1000 };

const 겹치나 = (a: Rect, b: Rect, gap = 48) =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

describe("놓을 자리", () => {
  it("빈 캔버스면 화면 가운데다", () => {
    const [p] = dropSpots(가운데, 1, SIZE, []);
    expect(p).toEqual({ x: 1000 - 150, y: 1000 - 100 });
  });

  it("가운데가 차 있으면 비켜 간다", () => {
    const 막힘: Rect[] = [{ x: 1000 - 150, y: 1000 - 100, ...SIZE }];
    const [p] = dropSpots(가운데, 1, SIZE, 막힘);
    expect(겹치나({ ...p, ...SIZE }, 막힘[0])).toBe(false);
  });

  it("여러 개를 놓아도 서로 안 겹친다", () => {
    const spots = dropSpots(가운데, 4, SIZE, []);
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        expect(겹치나({ ...spots[i], ...SIZE }, { ...spots[j], ...SIZE })).toBe(false);
      }
    }
  });

  it("빽빽해도 개수만큼은 준다 — 못 찾았다고 안 놓지 않는다", () => {
    const 벽: Rect[] = [];
    for (let i = 0; i < 200; i++) 벽.push({ x: 0, y: i * 40, w: 4000, h: 40 });
    const spots = dropSpots(가운데, 3, SIZE, 벽);
    expect(spots).toHaveLength(3);
  });

  it("기존 카드와도 안 겹친다", () => {
    const 있던것: Rect[] = [
      { x: 800, y: 900, w: 400, h: 300 },
      { x: 800, y: 1300, w: 400, h: 300 },
    ];
    const spots = dropSpots(가운데, 2, SIZE, 있던것);
    for (const s of spots) {
      for (const r of 있던것) expect(겹치나({ ...s, ...SIZE }, r)).toBe(false);
    }
  });
});
