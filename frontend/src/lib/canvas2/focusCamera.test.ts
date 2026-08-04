import { describe, expect, it } from "vitest";
import { focusCamera, visibleWorld } from "./focusCamera";
import { contains, type Rect } from "./rect";

const VP = { w: 1400, h: 850 };
const OPTS = { maxZoom: 2.35, minZoom: 1.1, pad: 80 };
const CARD: Rect = { x: 1000, y: 500, w: 560, h: 320 };
/** layout의 CHILD_GAP(88) 오른쪽에 붙는 클립 카드(CLIP_W=340). */
const CLIP: Rect = { x: 1000 + 560 + 88, y: 500, w: 340, h: 150 };

/** 카드가 235%로도 넉넉히 들어가는 큰 화면. D162의 조건이 성립하는 자리다. */
const WIDE = { w: 1920, h: 1080 };

describe("초점 카메라 (D163)", () => {
  it("넓은 화면 · 딸린 것이 없으면 D162 그대로 — 235%, 위 1/3", () => {
    const cam = focusCamera(CARD, [], WIDE, OPTS);
    expect(cam.zoom).toBe(2.35);
    expect(cam.scrollX).toBe(WIDE.w / 2 / 2.35 - (CARD.x + CARD.w / 2));
    expect(cam.scrollY).toBe(WIDE.h / 3 / 2.35 - CARD.y);
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
    const old = focusCamera(CARD, [], WIDE, OPTS);
    expect(contains(visibleWorld(old, WIDE), CLIP)).toBe(false);
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
  /**
   * 넘칠 때 카드 왼쪽에 남는 여백은 `pad`가 아니라 **UI 여백**이다 (D166).
   * pad를 쓰면 그만큼이 오른쪽 밖으로 밀려 클립이 잘린다 — 그래서 넘치는
   * 경우에는 UI 안쪽 변에 딱 붙인다. 그 변이 곧 카드 왼쪽의 여백이다.
   */
  it("묶음이 화면보다 넓으면 카드 왼쪽을 맞춘다(답이 안 잘린다)", () => {
    const vp = { ...VP, left: 72, right: 80, top: 56, bottom: 150 };
    const far: Rect = { x: CARD.x + 1600, y: CARD.y, w: 320, h: 700 };
    const cam = focusCamera(CARD, [CLIP, far], vp, OPTS);
    const seen = visibleWorld(cam, vp);
    expect(contains(seen, CARD)).toBe(true);   // 답은 온전히 보인다
    expect(contains(seen, CLIP)).toBe(true);   // 클립도 보인다
    expect(seen.x).toBeLessThan(CARD.x);       // 카드 왼쪽에 여백이 남는다
  });
});

/**
 * D166 — **답은 화면에 들어와야 한다.**
 *
 * D162가 배율을 235%로 고정한 탓에 폭 560 카드가 화면 위 1316px을 먹었다.
 * 교실 노트북(1366×768)·구형 크롬북(1024×768)에서는 화면보다 넓어 양쪽이
 * 잘렸고(실측 2026-08-04, 1024폭: 왼쪽 114px·오른쪽 178px이 화면 밖) 줄마다
 * 첫 글자가 왼쪽 레일 밑에 깔렸다. 학생 눈에는 **답이 안 뜬 것**과 같다.
 *
 * 이 블록이 지키는 것은 하나다: 딸린 것이 없는 답 하나는 어떤 화면에서도
 * 통째로 보인다. 배율은 그 다음 문제다.
 */
describe("좁은 화면에서도 답이 잘리지 않는다 (D166)", () => {
  /** 캔버스 위에 늘 떠 있는 UI. CanvasWorkspace의 UI_* 상수와 같은 값이다. */
  const CHROME = { left: 72, right: 80, top: 56, bottom: 150 };
  /** 실제로 글을 놓을 수 있는 화면 사각형. */
  const usable = (vp: { w: number; h: number }) => ({
    x: CHROME.left,
    y: CHROME.top,
    w: vp.w - CHROME.left - CHROME.right,
    h: vp.h - CHROME.top - CHROME.bottom,
  });

  const SCREENS = [
    { name: "구형 크롬북 1024×768", w: 1024, h: 768 },
    { name: "교실 노트북 1366×768", w: 1366, h: 768 },
    { name: "노트북 1512×945", w: 1512, h: 945 },
    { name: "데스크톱 1920×1080", w: 1920, h: 1080 },
  ];

  for (const s of SCREENS) {
    it(`${s.name} — 카드 가로가 UI 안쪽에 온전히 들어온다`, () => {
      const cam = focusCamera(CARD, [], { w: s.w, h: s.h, ...CHROME }, OPTS);
      const box = usable(s);
      // 카드의 화면 좌표. screen = (world + scroll) * zoom (CLAUDE.md의 규약).
      const left = (CARD.x + cam.scrollX) * cam.zoom;
      const right = (CARD.x + CARD.w + cam.scrollX) * cam.zoom;

      expect(left).toBeGreaterThanOrEqual(box.x);
      expect(right).toBeLessThanOrEqual(box.x + box.w);
      // 화면 자체도 넘지 않는다.
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(s.w);
    });

    it(`${s.name} — 그 안에서 가장 크게 당긴다(상한 235%)`, () => {
      const cam = focusCamera(CARD, [], { w: s.w, h: s.h, ...CHROME }, OPTS);
      expect(cam.zoom).toBeLessThanOrEqual(OPTS.maxZoom);
      // 축소는 필요한 만큼만 — 화면이 허락하면 상한에 붙어 있어야 한다.
      const room = (usable(s).w - OPTS.pad * 2) / CARD.w;
      expect(cam.zoom).toBeCloseTo(Math.min(OPTS.maxZoom, room), 6);
    });
  }

  it("1024에서 예전 규칙(고정 235%)은 실제로 잘렸다 — 회귀 근거", () => {
    const vp = { w: 1024, h: 768 };
    // 예전 코드가 하던 계산 그대로.
    const z = OPTS.maxZoom;
    const scrollX = vp.w / 2 / z - (CARD.x + CARD.w / 2);
    expect((CARD.x + scrollX) * z).toBeLessThan(0);                  // 왼쪽이 화면 밖
    expect((CARD.x + CARD.w + scrollX) * z).toBeGreaterThan(vp.w);   // 오른쪽도 화면 밖
  });

  /**
   * 글은 아래로 자란다. 높이까지 맞추려 들면 긴 답일수록 축소되어 D162가
   * 뒤집히므로, 세로는 **재지 않는다**는 것이 의도된 성질이다.
   */
  it("답이 길어도 배율은 그대로다 — 세로는 재지 않는다", () => {
    const vp = { w: 1366, h: 768, ...CHROME };
    const shortCard = focusCamera(CARD, [], vp, OPTS);
    const longCard = focusCamera({ ...CARD, h: 4000 }, [], vp, OPTS);
    expect(longCard.zoom).toBe(shortCard.zoom);
  });

  it("여백이 화면보다 커도 배율이 0이나 음수가 되지 않는다", () => {
    const cam = focusCamera(CARD, [], { w: 300, h: 200, ...CHROME }, OPTS);
    expect(cam.zoom).toBeGreaterThan(0);
    expect(cam.zoom).toBeGreaterThanOrEqual(OPTS.minZoom);
  });
});
