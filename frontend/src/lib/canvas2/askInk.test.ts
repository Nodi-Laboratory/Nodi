/**
 * 질문 필기 ↔ Excalidraw 요소 (D176).
 *
 * 좌표를 잘못 펴도 **화면에는 그럴싸한 그림이 나온다** — 모든 글자가 왼쪽 위에
 * 겹쳐 쌓여도 "글씨가 이상하네"로만 보인다. OCR 결과만 조용히 나빠진다.
 */

import { describe, expect, it } from "vitest";
import { NO_PRESSURE } from "./penPad";
import {
  ASK_MARK,
  askStrokes,
  bboxCorners,
  isAskStroke,
  markAsk,
  strokesBBox,
  toStrokes,
  allAskStrokes,
  pendingStrokes,
  withoutStrokes,
} from "./askInk";
import type { SceneStroke } from "./askInk";

const draw = (id: string, over: Partial<SceneStroke> = {}): SceneStroke => ({
  id,
  type: "freedraw",
  x: 0,
  y: 0,
  points: [
    [0, 0],
    [10, 10],
  ],
  ...over,
});
const asked = (id: string, over: Partial<SceneStroke> = {}) => markAsk(draw(id, over));

describe("질문 획과 그림 획의 구분", () => {
  it("표시가 있는 자유선만 질문이다", () => {
    const els = [asked("q1"), draw("pen1"), asked("q2")];
    expect(askStrokes(els).map((e) => e.id)).toEqual(["q1", "q2"]);
  });

  it("도형은 표시가 있어도 질문이 아니다 — 자유선만 글씨다", () => {
    const rect = markAsk(draw("r", { type: "rectangle" }));
    expect(isAskStroke(rect)).toBe(false);
  });

  it("지운 획은 세지 않는다 — Excalidraw는 지운 것을 배열에 남긴다", () => {
    expect(isAskStroke(asked("gone", { isDeleted: true }))).toBe(false);
  });

  it("표시는 원본을 고치지 않고 사본에 얹는다", () => {
    const before = draw("a", { customData: { other: 1 } });
    const after = markAsk(before);
    expect(before.customData).toEqual({ other: 1 }); // 원본 불변
    expect(after.customData).toEqual({ other: 1, [ASK_MARK]: true }); // 남의 값 보존
  });

  it("표시할 대상은 **켠 뒤에 그은** 자유선뿐이다", () => {
    const els = [asked("q"), draw("old"), draw("new"), draw("rect", { type: "rectangle" })];
    // 켠 순간 캔버스에 있던 것(old)에는 표시가 번지면 안 된다 — 그건 그림이다.
    const base = new Set(["q", "old"]);
    expect(pendingStrokes(els, base).map((e: { id: string }) => e.id)).toEqual(["new"]);
  });

  it("지금 질문으로 볼 획 = 표시된 것 + 방금 그은 것", () => {
    const els = [asked("q"), draw("old"), draw("new")];
    const base = new Set(["q", "old"]);
    expect(allAskStrokes(els, base).map((e: { id: string }) => e.id)).toEqual(["q", "new"]);
  });

  /**
   * **시점으로 가르면 안 되는 이유** — 도구를 잠깐 바꿨다 돌아와도 앞서 쓴
   * 질문 획은 계속 질문 획이어야 한다. 기준선 방식에서는 여기서 미아가 됐다.
   */
  it("도구를 오간 뒤에도 앞서 쓴 질문 획이 남는다", () => {
    const earlier = asked("q1"); // 질문하는 펜으로 씀
    const drawn = draw("pen1"); // 그 사이에 일반 펜으로 그림
    const later = asked("q2"); // 다시 질문하는 펜으로 씀
    expect(askStrokes([earlier, drawn, later]).map((e) => e.id)).toEqual(["q1", "q2"]);
  });
});

describe("요소 → 획", () => {
  it("**절대 좌표로 편다** — 안 그러면 모든 글자가 왼쪽 위에 겹친다", () => {
    const strokes = toStrokes([
      draw("a", { x: 100, y: 200, points: [[0, 0], [5, 5]] }),
      draw("b", { x: 300, y: 200, points: [[0, 0], [5, 5]] }),
    ]);
    expect(strokes[0][0]).toMatchObject({ x: 100, y: 200 });
    expect(strokes[1][0]).toMatchObject({ x: 300, y: 200 });
    expect(strokes[1][0].x - strokes[0][0].x).toBe(200);
  });

  it("필압은 있으면 쓰고 없으면 기본값", () => {
    const [withP] = toStrokes([draw("p", { pressures: [0.3, 0.9] })]);
    expect(withP.map((q) => q.p)).toEqual([0.3, 0.9]);
    const [without] = toStrokes([draw("q")]);
    expect(without.every((q) => q.p === NO_PRESSURE)).toBe(true);
  });

  it("점이 없는 요소는 건너뛴다", () => {
    expect(toStrokes([draw("empty", { points: [] })])).toEqual([]);
  });
});

describe("bbox — min/max 두 점 → 네 점 사각형", () => {
  it("흩어진 획 전부를 감싼다", () => {
    const strokes = toStrokes([
      draw("a", { x: 100, y: 200, points: [[0, 0], [20, 5]] }),
      draw("b", { x: 300, y: 150, points: [[0, 0], [10, 60]] }),
    ]);
    expect(strokesBBox(strokes)).toEqual({
      minX: 100,
      minY: 150,
      maxX: 310,
      maxY: 210,
    });
  });

  it("점 하나짜리 획도 센다 — 톡 찍은 꼭지도 글자의 일부다", () => {
    const strokes = toStrokes([draw("dot", { x: 5, y: 7, points: [[0, 0]] })]);
    expect(strokesBBox(strokes)).toEqual({ minX: 5, minY: 7, maxX: 5, maxY: 7 });
  });

  it("획이 없으면 null — 보낼 그림이 없다", () => {
    expect(strokesBBox([])).toBeNull();
  });

  it("두 점을 네 점으로 편다 (좌상 → 우상 → 우하 → 좌하)", () => {
    const corners = bboxCorners({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
    expect(corners).toEqual([
      [10, 20],
      [110, 20],
      [110, 70],
      [10, 70],
    ]);
    // 네 점이 실제로 사각형이다 — 가로변끼리, 세로변끼리 길이가 같다.
    const [tl, tr, br, bl] = corners;
    expect(tr[0] - tl[0]).toBe(br[0] - bl[0]);
    expect(bl[1] - tl[1]).toBe(br[1] - tr[1]);
  });
});

describe("지우기", () => {
  it("**걸러 낸다** — isDeleted로 남기면 다음에 다시 질문 획으로 잡힌다", () => {
    const rest = withoutStrokes([draw("keep"), draw("bye")], new Set(["bye"]));
    expect(rest.map((e) => e.id)).toEqual(["keep"]);
  });
});
