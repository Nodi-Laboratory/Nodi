/**
 * 자라는 카드에서 물러나는 카메라 (D210 2-2).
 *
 * 이 값들은 **손맛**이라 눈으로는 "좀 이상한데"까지만 알 수 있다. 규칙을
 * 값으로 못 박아 둔다 — 특히 "언제 아무것도 안 하는가"가 중요하다.
 */

import { describe, expect, it } from "vitest";
import { backOffCamera, type Camera } from "./focusCamera";

const VP = { w: 1440, h: 900, left: 72, right: 80, top: 56, bottom: 150 };
const OPTS = { minZoom: 0.6, headroom: 0.18, topPad: 40 };
/** 쓸 수 있는 세로 자리 = 900 − 56 − 150 = 694. */
const USABLE_H = VP.h - VP.top - VP.bottom;

/** 카드 위쪽이 화면 top+40에 오도록 맞춘 카메라. */
function camFor(card: { y: number }, zoom: number): Camera {
  return { zoom, scrollX: 0, scrollY: (VP.top + 40) / zoom - card.y };
}

describe("넘치지 않으면 아무 일도 하지 않는다", () => {
  it("짧은 카드는 null", () => {
    const card = { x: 0, y: 0, w: 560, h: 120 };
    expect(backOffCamera(card, camFor(card, 2.35), VP, OPTS)).toBeNull();
  });

  it("딱 들어가는 크기도 null — 경계에서 흔들리면 안 된다", () => {
    const zoom = 1;
    // 위 여백 40 + 높이 = 쓸 수 있는 자리 정확히
    const card = { x: 0, y: 0, w: 560, h: USABLE_H - 40 };
    expect(backOffCamera(card, camFor(card, zoom), VP, OPTS)).toBeNull();
  });
});

describe("넘치면 물러난다", () => {
  const card = { x: 0, y: 0, w: 560, h: 1200 };

  it("배율을 낮춘다 — 절대 키우지 않는다", () => {
    const cam = camFor(card, 2.35);
    const out = backOffCamera(card, cam, VP, OPTS)!;
    expect(out).not.toBeNull();
    expect(out.zoom).toBeLessThan(cam.zoom);
  });

  it("카드 아래에 화면의 15~20%를 남긴다", () => {
    // ⚠️ 하한(minZoom)에 안 걸리는 크기로 재야 한다 — 걸리면 그때부터는
    // "남길 자리"가 아니라 "더는 못 줄인다"가 결과를 정한다(아래 시험 참조).
    const card = { x: 0, y: 0, w: 560, h: 800 };
    const out = backOffCamera(card, camFor(card, 2.35), VP, OPTS)!;
    const 카드높이 = card.h * out.zoom;
    const 남은자리 = USABLE_H - 카드높이;
    const 비율 = 남은자리 / USABLE_H;
    expect(비율).toBeGreaterThan(0.14);
    expect(비율).toBeLessThan(0.22);
  });

  it("카드 위쪽이 화면 위에 붙는다 — 잘리는 쪽은 아래다", () => {
    const out = backOffCamera(card, camFor(card, 2.35), VP, OPTS)!;
    const 위쪽 = (card.y + out.scrollY) * out.zoom;
    expect(위쪽).toBeCloseTo(VP.top + OPTS.topPad, 6);
  });

  it("아주 긴 답에서도 하한 밑으로는 안 줄인다", () => {
    const 아주긴카드 = { x: 0, y: 0, w: 560, h: 40000 };
    const out = backOffCamera(아주긴카드, camFor(아주긴카드, 2.35), VP, OPTS)!;
    expect(out.zoom).toBe(OPTS.minZoom);
    // 하한에 닿아도 위쪽은 여전히 붙어 있다(읽기는 위에서 시작한다).
    const 위쪽 = (아주긴카드.y + out.scrollY) * out.zoom;
    expect(위쪽).toBeCloseTo(VP.top + OPTS.topPad, 6);
  });

  it("가로는 카드 중앙에 맞춘다", () => {
    const out = backOffCamera(card, camFor(card, 2.35), VP, OPTS)!;
    const 중앙 = (card.x + card.w / 2 + out.scrollX) * out.zoom;
    const 쓸수있는가운데 = VP.left + (VP.w - VP.left - (VP.right ?? 0)) / 2;
    expect(중앙).toBeCloseTo(쓸수있는가운데, 6);
  });

  it("한 번 물러난 뒤 더 자라면 또 물러난다 — 그러나 되키우지는 않는다", () => {
    const 작은카드 = { x: 0, y: 0, w: 560, h: 700 };
    const 처음 = backOffCamera(작은카드, camFor(작은카드, 2.35), VP, OPTS)!;
    const 더큰카드 = { ...작은카드, h: 900 };
    const 다음 = backOffCamera(더큰카드, 처음, VP, OPTS)!;
    expect(다음.zoom).toBeLessThan(처음.zoom);
    // 반대로 카드가 줄어도(편집 등) 배율을 올리지 않는다.
    const 작아진카드 = { ...작은카드, h: 200 };
    expect(backOffCamera(작아진카드, 다음, VP, OPTS)).toBeNull();
  });
});
