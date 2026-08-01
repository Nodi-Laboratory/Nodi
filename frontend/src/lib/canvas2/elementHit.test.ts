/**
 * 올가미 히트 테스트 — 사용자 지적을 그대로 못 박는다.
 *
 * "직접적으로 그 요소의 몸체를 선택하지 않고 배경 부분을 선택했는데 바운딩
 * 박스 안이라 선택됐다."
 */

import { describe, expect, it } from "vitest";
import { elementHitsRect, segmentHitsRect, type HitElement } from "./elementHit";
import type { Rect } from "./rect";

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe("빈 공간은 잡지 않는다", () => {
  it("대각선의 빈 모서리를 끌면 안 잡힌다", () => {
    // (0,0) → (100,100) 대각선. 바운딩 박스는 100×100이고 **오른쪽 위 절반은 비어 있다.**
    const line: HitElement = {
      type: "line",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      points: [
        [0, 0],
        [100, 100],
      ],
    };
    expect(elementHitsRect(line, r(70, 5, 25, 25))).toBe(false); // 오른쪽 위 빈 곳
    expect(elementHitsRect(line, r(5, 70, 25, 25))).toBe(false); // 왼쪽 아래 빈 곳
    expect(elementHitsRect(line, r(40, 40, 20, 20))).toBe(true); // 선이 지나는 곳
  });

  it("속이 빈 사각형의 가운데를 끌면 안 잡힌다", () => {
    const box: HitElement = {
      type: "rectangle",
      x: 0,
      y: 0,
      width: 200,
      height: 140,
      backgroundColor: "transparent",
    };
    expect(elementHitsRect(box, r(60, 40, 60, 50))).toBe(false); // 속 빈 가운데
    expect(elementHitsRect(box, r(-10, 60, 30, 20))).toBe(true); // 왼쪽 변에 걸침
    expect(elementHitsRect(box, r(90, -8, 30, 20))).toBe(true); // 윗변에 걸침
  });

  it("**채워진** 사각형은 속도 몸이다", () => {
    const filled: HitElement = {
      type: "rectangle",
      x: 0,
      y: 0,
      width: 200,
      height: 140,
      backgroundColor: "#ffd75e",
    };
    expect(elementHitsRect(filled, r(60, 40, 60, 50))).toBe(true);
  });

  it("타원의 네 귀퉁이(박스 안이지만 바깥)는 안 잡힌다", () => {
    const el: HitElement = {
      type: "ellipse",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      backgroundColor: "transparent",
    };
    // 왼쪽 위 귀퉁이 — 박스 안이지만 원 바깥이다.
    expect(elementHitsRect(el, r(0, 0, 18, 18))).toBe(false);
    // 원 둘레가 지나는 곳
    expect(elementHitsRect(el, r(92, -8, 16, 16))).toBe(true);
  });
});

describe("잡혀야 하는 것은 잡는다", () => {
  it("통째로 감싸면 잉크를 따지지 않고 잡는다", () => {
    const line: HitElement = {
      type: "line",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      points: [
        [0, 0],
        [100, 100],
      ],
    };
    expect(elementHitsRect(line, r(-20, -20, 200, 200))).toBe(true);
  });

  it("자유선의 한 획만 걸쳐도 잡는다", () => {
    const draw: HitElement = {
      type: "freedraw",
      x: 10,
      y: 10,
      width: 80,
      height: 40,
      points: [
        [0, 0],
        [20, 30],
        [40, 5],
        [80, 40],
      ],
    };
    expect(elementHitsRect(draw, r(45, 12, 8, 8))).toBe(true);
  });

  it("글자·그림처럼 덩어리인 요소는 박스로 판정한다", () => {
    const text: HitElement = { type: "text", x: 0, y: 0, width: 120, height: 24 };
    expect(elementHitsRect(text, r(50, 10, 6, 6))).toBe(true);
  });

  it("아예 떨어져 있으면 안 잡는다", () => {
    const box: HitElement = {
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      backgroundColor: "transparent",
    };
    expect(elementHitsRect(box, r(300, 300, 50, 50))).toBe(false);
  });
});

describe("회전", () => {
  it("돌아간 사각형의 변을 따라 판정한다", () => {
    // 45° 돌린 정사각형 — 돌리기 전의 귀퉁이 자리는 이제 비어 있다.
    const el: HitElement = {
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      angle: Math.PI / 4,
      backgroundColor: "transparent",
    };
    // 중심 (50,50)을 축으로 45° 돌면 꼭짓점이 (50,-20.7)·(120.7,50)·
    // (50,120.7)·(-20.7,50)로 간다. 즉 마름모다.
    expect(elementHitsRect(el, r(45, 45, 10, 10))).toBe(false); // 한가운데는 여전히 빔
    expect(elementHitsRect(el, r(44, -26, 12, 12))).toBe(true); // 위쪽 꼭짓점을 문다
    // 원래(안 돌린) 사각형의 왼쪽 위 귀퉁이 자리는 이제 **비어 있다** —
    // 회전을 무시하면 여기서 거짓 양성이 난다.
    expect(elementHitsRect(el, r(2, 2, 10, 10))).toBe(false);
  });
});

describe("segmentHitsRect", () => {
  it("끝점이 안에 있으면 참", () => {
    expect(segmentHitsRect({ x: 5, y: 5 }, { x: 100, y: 100 }, r(0, 0, 10, 10))).toBe(true);
  });
  it("사각형을 관통하면 참", () => {
    expect(segmentHitsRect({ x: -10, y: 5 }, { x: 20, y: 5 }, r(0, 0, 10, 10))).toBe(true);
  });
  it("스치지도 않으면 거짓", () => {
    expect(segmentHitsRect({ x: -10, y: 50 }, { x: 20, y: 50 }, r(0, 0, 10, 10))).toBe(false);
  });
});
