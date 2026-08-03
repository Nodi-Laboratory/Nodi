import { describe, expect, it } from "vitest";
import { focusCamera, visibleWorld } from "./focusCamera";
import { contains, type Rect } from "./rect";

const VP = { w: 1400, h: 850 };
const OPTS = { maxZoom: 2.35, minZoom: 1.1, pad: 80 };
const CARD: Rect = { x: 1000, y: 500, w: 560, h: 320 };
/** layout의 CHILD_GAP(88) 오른쪽에 붙는 클립 카드(CLIP_W=340). */
const CLIP: Rect = { x: 1000 + 560 + 88, y: 500, w: 340, h: 150 };

describe("초점 카메라 (D163)", () => {
  it("딸린 것이 없으면 D162 그대로 — 235%, 위 1/3", () => {
    const cam = focusCamera(CARD, [], VP, OPTS);
    expect(cam.zoom).toBe(2.35);
    expect(cam.scrollX).toBe(VP.w / 2 / 2.35 - (CARD.x + CARD.w / 2));
    expect(cam.scrollY).toBe(VP.h / 3 / 2.35 - CARD.y);
  });

  /**
   * 이게 이 파일의 존재 이유다. 예전 규칙(고정 235%)에서는 클립이 화면 밖에
   * 있었고, 화면에도 로그에도 아무 흔적이 없었다.
   */
  it("클립이 딸리면 클립까지 화면 안에 들어온다", () => {
    const cam = focusCamera(CARD, [CLIP], VP, OPTS);
    const seen = visibleWorld(cam, VP);
    expect(contains(seen, CARD)).toBe(true);
    expect(contains(seen, CLIP)).toBe(true);
  });

  it("고정 235%였다면 클립은 화면 밖이었다(회귀 근거)", () => {
    const old = focusCamera(CARD, [], VP, OPTS);
    expect(contains(visibleWorld(old, VP), CLIP)).toBe(false);
  });

  it("클립이 셋이어도 다 들어온다", () => {
    const clips = [0, 1, 2].map((i) => ({ ...CLIP, y: CLIP.y + i * 170 }));
    const cam = focusCamera(CARD, clips, VP, OPTS);
    const seen = visibleWorld(cam, VP);
    for (const c of clips) expect(contains(seen, c)).toBe(true);
    expect(contains(seen, CARD)).toBe(true);
  });

  it("다 담겠다고 글씨를 못 읽을 배율까지 내려가지는 않는다", () => {
    // 말도 안 되게 큰 묶음 — 하한에서 멈춘다.
    const huge: Rect = { x: 0, y: 0, w: 20000, h: 20000 };
    const cam = focusCamera(CARD, [huge], VP, OPTS);
    expect(cam.zoom).toBe(OPTS.minZoom);
  });

  it("확대는 235%를 넘지 않는다(작은 묶음이라도)", () => {
    const tiny: Rect = { x: CARD.x + 10, y: CARD.y + 10, w: 20, h: 20 };
    const cam = focusCamera({ ...CARD, w: 40, h: 40 }, [tiny], VP, OPTS);
    expect(cam.zoom).toBeLessThanOrEqual(OPTS.maxZoom);
  });

  it("묶음이 들어가면 가로 가운데에 둔다", () => {
    const cam = focusCamera(CARD, [CLIP], VP, OPTS);
    const seen = visibleWorld(cam, VP);
    const bx = (CARD.x + CLIP.x + CLIP.w) / 2;
    expect(seen.x + seen.w / 2).toBeCloseTo(bx, 6);
  });

  /**
   * 좁은 화면(1280)에서 클립 셋 + 도판 셋이 붙으면 묶음이 화면보다 넓다.
   * 가운데에 두면 **답의 첫 글자가 잘린다** — 실측 스크린샷에서 개념 카드
   * 왼쪽이 잘려 있었다.
   */
  it("묶음이 화면보다 넓으면 카드 왼쪽을 맞춘다(답이 안 잘린다)", () => {
    const far: Rect = { x: CARD.x + 1600, y: CARD.y, w: 320, h: 700 };
    const cam = focusCamera(CARD, [CLIP, far], VP, OPTS);
    const seen = visibleWorld(cam, VP);
    expect(contains(seen, CARD)).toBe(true);   // 답은 온전히 보인다
    expect(contains(seen, CLIP)).toBe(true);   // 클립도 보인다
    expect(seen.x).toBeLessThan(CARD.x);       // 카드 왼쪽에 여백이 남는다
  });
});
