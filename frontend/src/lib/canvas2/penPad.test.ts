/**
 * 펜 입력판 기하 테스트 (D176).
 *
 * 여기서 틀리면 **그럴싸한 그림이 나온다** — 획 끝이 조금 잘리거나 여백이
 * 한쪽만 붙어도 눈으로는 모르고, OCR 결과만 조용히 나빠진다.
 */

import { describe, expect, it } from "vitest";
import {
  BASE_WIDTH,
  EXPORT_PAD,
  MAX_EXPORT_SIDE,
  MIN_INK,
  NO_PRESSURE,
  exportBox,
  exportScale,
  hasInk,
  inkBounds,
  inkLength,
  penWidth,
  shouldAppend,
} from "./penPad";
import type { PenStroke } from "./penPad";

/** 필압 없는 입력(마우스)으로 그은 가로선. */
const line = (x0: number, y: number, len: number, step = 4): PenStroke => {
  const pts = [];
  for (let d = 0; d <= len; d += step) pts.push({ x: x0 + d, y, p: NO_PRESSURE });
  return pts;
};

describe("필압 → 굵기", () => {
  it("셀수록 굵다", () => {
    expect(penWidth(0.9)).toBeGreaterThan(penWidth(0.2));
  });

  it("아무리 살살 써도 0이 되지 않는다 — 획이 끊기면 OCR에는 다른 글자다", () => {
    expect(penWidth(0)).toBeGreaterThan(0);
  });

  it("범위 밖 · 값 없음도 굵기를 낸다", () => {
    expect(penWidth(5)).toBe(penWidth(1));
    expect(penWidth(-1)).toBe(penWidth(0));
    expect(penWidth(Number.NaN)).toBe(penWidth(NO_PRESSURE));
  });
});

describe("점 솎기", () => {
  it("첫 점은 언제나 담는다", () => {
    expect(shouldAppend(undefined, { x: 0, y: 0, p: 0.5 })).toBe(true);
  });

  it("같은 자리의 떨림은 버린다", () => {
    const last = { x: 10, y: 10, p: 0.5 };
    expect(shouldAppend(last, { x: 10.3, y: 10.2, p: 0.5 })).toBe(false);
    expect(shouldAppend(last, { x: 14, y: 10, p: 0.5 })).toBe(true);
  });
});

describe("썼는지 판정", () => {
  it("톡 하고 놓은 점 하나는 쓴 것이 아니다", () => {
    expect(hasInk([[{ x: 5, y: 5, p: 0.4 }]])).toBe(false);
  });

  it("획 길이 합으로 본다 — 짧은 획 여럿도 모이면 글씨다", () => {
    const many = Array.from({ length: 6 }, (_, i) => line(i * 12, 20, 10));
    expect(inkLength(many)).toBeGreaterThanOrEqual(MIN_INK);
    expect(hasInk(many)).toBe(true);
  });

  it("빈 배열은 false", () => {
    expect(hasInk([])).toBe(false);
  });
});

describe("경계", () => {
  it("획이 없으면 null", () => {
    expect(inkBounds([])).toBeNull();
    expect(inkBounds([[]])).toBeNull();
  });

  it("굵기의 절반을 사방에 더한다 — 점 좌표로만 재면 획 바깥이 잘린다", () => {
    const r = penWidth(NO_PRESSURE, BASE_WIDTH) / 2;
    const b = inkBounds([line(100, 50, 40)])!;
    expect(b.x).toBeCloseTo(100 - r, 6);
    expect(b.y).toBeCloseTo(50 - r, 6);
    expect(b.w).toBeCloseTo(40 + r * 2, 6);
    expect(b.h).toBeCloseTo(r * 2, 6);
  });

  it("모든 점을 담는다", () => {
    const strokes = [line(0, 0, 30), line(200, 120, 30), line(-40, 80, 10)];
    const b = inkBounds(strokes)!;
    for (const s of strokes) {
      for (const pt of s) {
        expect(pt.x).toBeGreaterThanOrEqual(b.x);
        expect(pt.y).toBeGreaterThanOrEqual(b.y);
        expect(pt.x).toBeLessThanOrEqual(b.x + b.w);
        expect(pt.y).toBeLessThanOrEqual(b.y + b.h);
      }
    }
  });
});

describe("전송본 상자", () => {
  it("사방에 같은 여백을 준다", () => {
    const box = exportBox({ x: 10, y: 20, w: 100, h: 40 });
    expect(box.x).toBe(10 - EXPORT_PAD);
    expect(box.y).toBe(20 - EXPORT_PAD);
    expect(box.w).toBe(100 + EXPORT_PAD * 2);
    expect(box.h).toBe(40 + EXPORT_PAD * 2);
  });

  it("판 밖으로 나가도 자르지 않는다 — 전송본은 새로 그리는 흰 종이다", () => {
    // 왼쪽 끝에 딱 붙여 쓴 경우. 잘라 버리면 그 글자만 여백을 못 받는다.
    const box = exportBox({ x: 0, y: 0, w: 50, h: 30 });
    expect(box.x).toBeLessThan(0);
    expect(box.y).toBeLessThan(0);
  });
});

describe("전송본 배율", () => {
  it("화면 배율만큼 키우되 2배를 넘기지 않는다", () => {
    const small = { x: 0, y: 0, w: 120, h: 80 };
    expect(exportScale(small, 1)).toBe(1);
    expect(exportScale(small, 2)).toBe(2);
    expect(exportScale(small, 3)).toBe(2);
  });

  it("가로로 길게 쓴 글씨는 한 변 상한에 맞춰 줄인다", () => {
    const wide = { x: 0, y: 0, w: 3000, h: 200 };
    const s = exportScale(wide, 2);
    expect(wide.w * s).toBeLessThanOrEqual(MAX_EXPORT_SIDE + 1e-6);
    expect(s).toBeLessThan(1);
  });

  it("dpr을 모르는 환경도 그림을 만든다", () => {
    expect(exportScale({ x: 0, y: 0, w: 100, h: 50 }, Number.NaN)).toBeGreaterThan(0);
  });
});
