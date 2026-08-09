/** 모서리 스냅 (D210 5-1). */

import { describe, expect, it } from "vitest";
import { CORNERS, cornerPos, nearestCorner, SNAP_MARGIN } from "./cornerSnap";

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
  it("붙을 수 있는 모서리에 둔 것은 그 모서리로 돌아간다", () => {
    for (const c of CORNERS) {
      expect(nearestCorner(cornerPos(c, VP, BOX), VP, BOX)).toBe(c);
    }
  });

  /**
   * 좌상단이 **2026-08-09에 돌아왔다** (사용자 지시).
   *
   * D211 9에서 뺐던 이유는 거기 대화 목록·배율 버튼이 있어 미니맵이 가려
   * 버린다는 것이었는데, 그 두 버튼을 걷어내면서 자리가 비었다. 남은 것은
   * "어느 학급 어느 대화방" 글자 한 줄이고 `pointer-events: none`이다.
   */
  it("네 모서리를 다 쓴다", () => {
    expect([...CORNERS].sort()).toEqual(["bl", "br", "tl", "tr"]);
    expect(nearestCorner(cornerPos("tl", VP, BOX), VP, BOX)).toBe("tl");
  });

  it("왼쪽 가장자리 한가운데는 **왼쪽** 모서리로 간다", () => {
    /**
     * 사분면으로 가르면 여기서 직관과 어긋난다 — y가 종이 한 장 차이로
     * 위/아래를 가르는데, 눈으로는 "왼쪽에 붙는다"가 먼저다. 중심 거리로
     * 재면 왼쪽 둘 중 하나가 나온다.
     */
    const 왼쪽중앙 = { x: SNAP_MARGIN, y: (VP.h - BOX.h) / 2 };
    expect(["tl", "bl"]).toContain(nearestCorner(왼쪽중앙, VP, BOX));
  });

  it("오른쪽 아래로 끌면 br", () => {
    expect(nearestCorner({ x: 1000, y: 600 }, VP, BOX)).toBe("br");
  });
});
