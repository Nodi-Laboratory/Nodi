"use client";

/**
 * **소프트 키보드가 먹은 높이**를 CSS 변수로 흘린다 (사용자 지시 2026-08-10).
 *
 * ## 무엇이 문제인가
 *
 * 입력창은 무대 안에 `absolute bottom-…`으로 앉아 있다. 데스크톱에서는 그것이
 * 곧 화면 아래이지만, **패드·폰에서 키보드가 올라오면 아래쪽이 가려진다.**
 *
 * 기기마다 다르게 가린다:
 *
 *   · iOS 사파리 — `innerHeight`는 **안 바뀐다.** 줄어드는 것은
 *     `visualViewport.height`뿐이라, 레이아웃은 키보드를 모른 채 그대로 있고
 *     입력창은 키보드 **밑에 깔린다**. 학생이 자기가 치는 글을 못 본다.
 *   · 안드로이드 크롬 — 보통 레이아웃 뷰포트까지 줄여 주지만, 설정에 따라
 *     iOS와 같이 동작한다.
 *
 * 그래서 **둘 다 성립하는 방법**으로 잰다: 시각 뷰포트가 레이아웃 뷰포트보다
 * 얼마나 짧은가. 안 가려졌으면 0이라 아무 일도 안 일어난다.
 *
 * ## 왜 React state가 아닌가
 *
 * 키보드가 오르내리는 동안 이 값은 프레임마다 바뀐다. state로 두면 그때마다
 * 캔버스 전체가 다시 렌더된다 — D124가 팬/줌에서 이미 겪은 문제다. CSS 변수를
 * 직접 써서 **브라우저가 배치만 다시 하게** 한다.
 */

/** 키보드가 먹은 높이(px). 안 가려졌으면 0. */
export function keyboardInset(
  layoutHeight: number,
  visual: { height: number; offsetTop: number } | null,
): number {
  if (!visual) return 0;
  // 시각 뷰포트가 위로 밀려 있으면(offsetTop) 그만큼도 가려진 것이다.
  const covered = layoutHeight - visual.height - visual.offsetTop;
  // 음수는 없다. 아주 작은 값은 주소창이 접히는 것 같은 잡음이라 무시한다 —
  // 그걸로 입력창이 들썩이면 오히려 산만하다.
  return covered > 24 ? Math.round(covered) : 0;
}

/** 문서에 `--kb-inset`을 달아 둔다. 끄는 함수를 돌려준다. */
export function watchKeyboardInset(): () => void {
  if (typeof window === "undefined") return () => {};
  const vv = window.visualViewport;
  if (!vv) return () => {};

  const apply = () => {
    const px = keyboardInset(window.innerHeight, {
      height: vv.height,
      offsetTop: vv.offsetTop,
    });
    document.documentElement.style.setProperty("--kb-inset", `${px}px`);
  };

  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    document.documentElement.style.removeProperty("--kb-inset");
  };
}
