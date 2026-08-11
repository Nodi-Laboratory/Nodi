import { describe, expect, it } from "vitest";
import { keyboardInset } from "./keyboardInset";

/**
 * 소프트 키보드가 먹은 높이 (사용자 지시 2026-08-10).
 *
 * ⚠️ iOS 사파리는 키보드가 올라와도 `innerHeight`를 **안 줄인다.** 줄어드는
 * 것은 `visualViewport.height`뿐이라, 레이아웃은 키보드를 모른 채 그대로 있고
 * 아래에 붙은 입력창은 그 밑에 깔린다 — 학생이 자기가 치는 글을 못 본다.
 */
describe("keyboardInset", () => {
  it("키보드가 없으면 0이다", () => {
    expect(keyboardInset(834, { height: 834, offsetTop: 0 })).toBe(0);
  });

  it("가린 만큼 돌려준다 (아이패드 세로 + 키보드)", () => {
    expect(keyboardInset(1194, { height: 830, offsetTop: 0 })).toBe(364);
  });

  it("시각 뷰포트가 위로 밀린 것도 가려진 것이다", () => {
    // 입력창으로 스크롤되며 뷰포트가 밀리는 경우.
    expect(keyboardInset(1000, { height: 600, offsetTop: 100 })).toBe(300);
  });

  it("작은 차이는 무시한다", () => {
    /**
     * 주소창이 접히는 것 같은 잡음까지 따라가면 입력창이 들썩인다 — 그건
     * 가려지는 것보다 산만하다.
     */
    expect(keyboardInset(834, { height: 820, offsetTop: 0 })).toBe(0);
  });

  it("음수가 나오지 않는다", () => {
    // 시각 뷰포트가 레이아웃보다 큰 순간이 실제로 있다(고무줄 스크롤).
    expect(keyboardInset(800, { height: 900, offsetTop: 0 })).toBe(0);
  });

  it("visualViewport가 없는 브라우저에서는 0이다", () => {
    expect(keyboardInset(800, null)).toBe(0);
  });
});
