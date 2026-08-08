/** 모서리 스냅 (D210 5-1). */

import { describe, expect, it } from "vitest";
import { cornerPos, nearestCorner, SNAP_MARGIN } from "./cornerSnap";

const VP = { w: 1440, h: 900 };
const BOX = { w: 340, h: 250 };

describe("모서리 자리", () => {
  it("네 모서리가 서로 다른 자리다", () => {
    const 자리 = (["tl", "tr", "bl", "br"] as const).map((c) =>
      JSON.stringify(cornerPos(c, VP, BOX)),
    );
    expect(new Set(자리).size).toBe(4);
  });

  it("화면 끝에 딱 붙지 않는다", () => {
    const br = cornerPos("br", VP, BOX);
    expect(br.x + BOX.w).toBe(VP.w - SNAP_MARGIN);
    expect(br.y + BOX.h).toBe(VP.h - SNAP_MARGIN);
  });

  it("창이 상자보다 작아도 화면 밖으로 안 나간다", () => {
    const p = cornerPos("br", { w: 200, h: 150 }, BOX);
    expect(p.x).toBeGreaterThanOrEqual(SNAP_MARGIN);
    expect(p.y).toBeGreaterThanOrEqual(SNAP_MARGIN);
  });
});

describe("가장 가까운 모서리", () => {
  it("각 모서리에 둔 것은 그 모서리로 돌아간다", () => {
    for (const c of ["tl", "tr", "bl", "br"] as const) {
      expect(nearestCorner(cornerPos(c, VP, BOX), VP, BOX)).toBe(c);
    }
  });

  it("왼쪽 가장자리 한가운데는 **왼쪽** 모서리로 간다", () => {
    /**
     * 사분면으로 가르면 여기서 직관과 어긋난다 — y가 종이 한 장 차이로
     * 위/아래를 가르는데, 눈으로는 "왼쪽에 붙는다"가 먼저다. 중심 거리로
     * 재면 왼쪽 둘 중 하나가 나온다.
     */
    const 왼쪽중앙 = { x: SNAP_MARGIN, y: (VP.h - BOX.h) / 2 };
    expect(nearestCorner(왼쪽중앙, VP, BOX)).toMatch(/^(tl|bl)$/);
  });

  it("오른쪽 아래로 끌면 br", () => {
    expect(nearestCorner({ x: 1000, y: 600 }, VP, BOX)).toBe("br");
  });
});
