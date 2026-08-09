/** 크롬 자리 잡기 (사용자 지시 2026-08-08). */

import { describe, expect, it } from "vitest";
import { fitChrome, type ChromeInput } from "./chromeFit";

const 기본: ChromeInput = {
  stage: { w: 1376, h: 900 },
  corner: "tr",
  map: { w: 272, h: 208 },
  rail: { w: 50, h: 543 },
  askW: 680,
  margin: 16,
  gap: 14,
};

describe("평소에는 아무것도 안 한다", () => {
  it("지도가 닫혀 있으면 그대로", () => {
    expect(fitChrome({ ...기본, corner: null })).toMatchObject({
      railMode: "center",
      railShift: 0,
      mapDx: 0,
    });
  });

  it("지도가 왼쪽이면 도구바와 만날 일이 없다", () => {
    for (const corner of ["tl", "bl"] as const) {
      expect(fitChrome({ ...기본, corner }).railShift).toBe(0);
    }
  });

  it("안 겹치면 안 민다", () => {
    // 도구바가 짧으면 우상단 지도와 만나지 않는다.
    expect(fitChrome({ ...기본, rail: { w: 50, h: 200 } })).toMatchObject({
      railMode: "center",
      railShift: 0,
    });
  });
});

describe("겹치면 먼저 비켜선다", () => {
  it("우상단 지도 아래로 내려간다", () => {
    const r = fitChrome(기본);
    expect(r.railMode).toBe("center");
    expect(r.railShift).toBeGreaterThan(0);
    expect(r.mapDx).toBe(0);
  });

  it("우하단 지도 위로 올라간다", () => {
    const r = fitChrome({ ...기본, corner: "br" });
    expect(r.railMode).toBe("center");
    expect(r.railShift).toBeLessThan(0);
  });

  it("비켜선 뒤에는 지도와 안 겹친다", () => {
    const r = fitChrome(기본);
    const railTop = (기본.stage.h - 기본.rail.h) / 2 + r.railShift;
    expect(railTop).toBeGreaterThanOrEqual(기본.margin + 기본.map.h);
  });
});

describe("밀어도 안 되면 나란히 선다", () => {
  /** 화면이 낮으면 도구바를 밀 자리가 없다 — 교실 노트북·태블릿이 그렇다. */
  const 낮은화면: ChromeInput = { ...기본, stage: { w: 1376, h: 620 } };

  it("우상단이면 도구바가 위쪽 정렬로 간다", () => {
    const r = fitChrome(낮은화면);
    expect(r.railMode).toBe("top");
    expect(r.railShift).toBe(0);
  });

  it("우하단이면 아래쪽 정렬로 간다", () => {
    const r = fitChrome({ ...낮은화면, corner: "br" });
    expect(r.railMode).toBe("bottom");
  });

  it("지도가 도구바 폭+틈만큼 왼쪽으로 물러난다", () => {
    const r = fitChrome(낮은화면);
    expect(r.mapDx).toBe(낮은화면.rail.w + 낮은화면.gap);
  });

  it("물러난 지도와 도구바가 가로로 안 겹친다", () => {
    const r = fitChrome(낮은화면);
    const railLeft = 낮은화면.stage.w - 낮은화면.margin - 낮은화면.rail.w;
    const mapRight = 낮은화면.stage.w - 낮은화면.margin - r.mapDx;
    expect(mapRight).toBeLessThanOrEqual(railLeft);
  });
});

describe("입력창은 지도가 아래에 올 때만 비킨다", () => {
  const 좁은화면: ChromeInput = { ...기본, stage: { w: 900, h: 620 }, corner: "br" };

  it("우하단 지도와 겹치면 왼쪽으로 민다", () => {
    const r = fitChrome(좁은화면);
    expect(r.askDx).toBeGreaterThan(0);
  });

  /** 실제로 그려질 입력창의 좌우 변(화면 px). 줄어들었으면 그 폭으로 잰다. */
  function 입력창변(input: ChromeInput) {
    const r = fitChrome(input);
    const w = r.askMaxW ?? input.askW;
    const left = (input.stage.w - w) / 2 - r.askDx;
    return { left, right: left + w, fit: r };
  }

  it("민 뒤에는 지도와 안 겹친다", () => {
    const { right, fit } = 입력창변(좁은화면);
    const mapLeft = 좁은화면.stage.w - 좁은화면.margin - 좁은화면.map.w - fit.mapDx;
    expect(right).toBeLessThanOrEqual(mapLeft);
  });

  /**
   * 옛 규칙에는 상한이 없어서 입력창이 **화면 밖**을 가리켰다 (2026-08-09).
   *
   * 실측 1440×900: 왼쪽 변 −117px — 첨부 버튼과 안내 문구가 통째로 사라져
   * 학생이 파일을 붙일 수 없었다. 겹치는 것보다 나쁘다.
   */
  it("아무리 밀어도 왼쪽 여백을 넘지 않는다", () => {
    for (const w of [700, 900, 1100, 1350, 1440]) {
      const { left } = 입력창변({ ...기본, stage: { w, h: 620 }, corner: "br" });
      expect(left).toBeGreaterThanOrEqual(기본.margin - 0.5);
    }
  });

  it("자리가 모자라면 입력창이 줄어든다", () => {
    // 지도·도구바·틈을 빼고 남는 자리보다 입력창이 넓은 화면.
    const 빡빡 = { ...기본, stage: { w: 900, h: 620 }, corner: "br" as const };
    const r = fitChrome(빡빡);
    const room =
      빡빡.stage.w - 빡빡.margin - 빡빡.map.w - r.mapDx - 빡빡.gap - 빡빡.margin;
    if (빡빡.askW > room) {
      expect(r.askMaxW).not.toBeNull();
      expect(r.askMaxW as number).toBeLessThanOrEqual(room + 0.5);
    }
  });

  it("지도가 위쪽이면 입력창은 안 건드린다", () => {
    expect(fitChrome({ ...좁은화면, corner: "tr" }).askDx).toBe(0);
  });

  it("넓은 화면에서는 밀 필요가 없다", () => {
    expect(fitChrome({ ...기본, stage: { w: 1800, h: 620 }, corner: "br" }).askDx).toBe(0);
  });
});
