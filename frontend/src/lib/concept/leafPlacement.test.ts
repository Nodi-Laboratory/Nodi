import { describe, expect, it } from "vitest";
import { LEAF_DIMS, cardRect, leafRect, placeLeafClear, type Rect } from "./leafPlacement";
import { CARD_W } from "./curriculumTags";
import { cardHeight } from "./cardMetrics";
import type { CanvasLeafNode, Concept } from "./types";

/**
 * 도판 리프 무겹침 배치 회귀 (D105).
 *
 * 요구는 하나다: **리프가 카드나 다른 리프와 겹치면 안 된다.** 나선 탐색이
 * 조용히 틀리면 도판이 카드 위에 얹혀 본문을 가린다 — 화면을 봐야만 보이는 버그다.
 */

const GAP = 24; // leafPlacement 내부 상수와 같은 값(계약을 여기서 고정한다)

/** 두 사각형이 gap을 포함해 겹치는가. */
function overlaps(a: Rect, b: Rect, gap = GAP): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

const concept = (over: Partial<Concept> = {}): Concept =>
  ({ id: "c1", title: "", cluster: "", blocks: [], related: [], x: 0, y: 0, done: true, ...over }) as Concept;

describe("사각형 산출", () => {
  it("카드 사각형은 폭 SSOT와 높이 추정을 그대로 쓴다", () => {
    const c = concept({ x: 100, y: 200 });
    expect(cardRect(c)).toEqual({ x: 100, y: 200, w: CARD_W, h: cardHeight(c, false) });
  });

  it("출처 칩이 있으면 카드 사각형도 그만큼 높다", () => {
    const c = concept({ sources: [{ file_id: "f", name: "n" }] as Concept["sources"] });
    expect(cardRect(c).h).toBe(cardHeight(c, true));
  });

  it("리프 사각형은 타입별 고정 치수", () => {
    const n: CanvasLeafNode = { id: "l1", type: "figure", x: 10, y: 20 };
    expect(leafRect(n)).toEqual({ x: 10, y: 20, w: LEAF_DIMS.figure.w, h: LEAF_DIMS.figure.h });
  });
});

describe("빈 자리 탐색", () => {
  const { w, h } = LEAF_DIMS.figure;

  it("장애물이 없으면 선호 위치를 그대로 쓴다", () => {
    expect(placeLeafClear(500, 300, w, h, [])).toEqual({ x: 500, y: 300 });
  });

  it("선호 위치가 막히면 다른 자리를 찾는다", () => {
    const blocker: Rect = { x: 500, y: 300, w: 400, h: 400 };
    const got = placeLeafClear(500, 300, w, h, [blocker]);
    expect(got).not.toEqual({ x: 500, y: 300 });
    expect(overlaps({ ...got, w, h }, blocker)).toBe(false);
  });

  it("여러 장애물 중 **어느 것과도** 겹치지 않는다", () => {
    const obstacles: Rect[] = [
      { x: 0, y: 0, w: 420, h: 300 },
      { x: 460, y: 0, w: 420, h: 300 },
      { x: 0, y: 360, w: 420, h: 300 },
      { x: 460, y: 360, w: 420, h: 300 },
    ];
    const got = placeLeafClear(440, 330, w, h, obstacles);
    for (const o of obstacles) {
      expect(overlaps({ ...got, w, h }, o)).toBe(false);
    }
  });

  it("결정론이다 — 같은 입력이면 같은 좌표", () => {
    // 재수화 때마다 도판이 다른 자리에 뜨면 안 된다.
    const obstacles: Rect[] = [{ x: 500, y: 300, w: 400, h: 400 }];
    const a = placeLeafClear(500, 300, w, h, obstacles);
    const b = placeLeafClear(500, 300, w, h, obstacles);
    expect(a).toEqual(b);
  });

  it("막힌 경우에도 선호 위치에서 멀지 않은 곳을 고른다", () => {
    // 나선은 가까운 링부터 훑으므로, 첫 링 근처에서 답이 나와야 한다.
    const got = placeLeafClear(0, 0, w, h, [{ x: 0, y: 0, w: 100, h: 100 }]);
    expect(Math.hypot(got.x, got.y)).toBeLessThanOrEqual(360); // 3링 이내
  });

  it("gap을 0으로 주면 딱 붙는 자리도 허용한다", () => {
    const blocker: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const got = placeLeafClear(100, 0, w, h, [blocker], 0);
    expect(got).toEqual({ x: 100, y: 0 });
  });
});
