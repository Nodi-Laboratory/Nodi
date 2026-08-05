/**
 * 펜 활동 시간 창 (D171).
 *
 * 이 판정이 틀리면 두 가지로 갈리는데 **둘 다 화면에 안 드러난다**:
 * 창이 짧으면 쓰는 중에 손날이 도구를 바꾸고, 길면 손가락으로 누른 버튼이
 * 아무 일도 안 한다.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { PEN_WINDOW_MS, notePen, penActive, resetPenWatch } from "./penGuard";

beforeEach(() => resetPenWatch());

it("펜을 본 적 없으면 아무것도 막지 않는다 — 손가락으로만 쓰는 기기", () => {
  expect(penActive(0)).toBe(false);
  expect(penActive(1e9)).toBe(false);
});

describe("펜을 본 뒤", () => {
  it("그 순간과 창 안은 '쓰는 중'이다", () => {
    notePen(1000);
    expect(penActive(1000)).toBe(true);
    expect(penActive(1000 + PEN_WINDOW_MS - 1)).toBe(true);
  });

  it("창이 지나면 손가락 조작을 통과시킨다", () => {
    notePen(1000);
    expect(penActive(1000 + PEN_WINDOW_MS)).toBe(false);
  });

  it("획을 긋는 동안 계속 갱신된다 — 창이 획 중간에 닫히지 않는다", () => {
    notePen(0);
    for (let t = 100; t <= 5000; t += 100) notePen(t);
    expect(penActive(5000 + PEN_WINDOW_MS - 1)).toBe(true);
  });
});
