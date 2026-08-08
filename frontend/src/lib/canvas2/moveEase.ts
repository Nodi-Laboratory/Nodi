/**
 * 열을 옮겨 가는 이동만 **느리게** 한다 (D210 6-3).
 *
 * 카드를 이으면 그 가지 전체가 부모의 분류를 따라가고, 분류가 바뀌면 배치의
 * 열도 바뀐다. 평소 이동값(0.28초)으로 700px 넘는 열 사이를 건너면 눈에는
 * 순간이동에 가깝다 — 무슨 일이 일어났는지 안 보인다.
 *
 * ## 왜 인라인이 아니라 변수인가
 *
 * 아이템의 전이는 `TextItem`의 인라인 스타일이라 클래스 규칙으로는 못 이긴다.
 * 대신 인라인 쪽이 `var(--c2-move, .28s)`를 읽게 해 두고, 여기서는 무대에
 * 그 변수만 얹는다. 인라인과 싸우지 않으므로 `!important`가 필요 없고,
 * 드래그 중 `transition: none`으로 끄는 길도 그대로 산다.
 *
 * ## 연결선은 속성 게이트로 따로 연다
 *
 * 연결선은 드래그 중 매 프레임 `d`·`cx`를 직접 쓴다 — 전이를 상시로 켜 두면
 * 선이 카드보다 늦게 따라와 **끌 때마다 늘어진 고무줄**이 된다. 그래서
 * `data-c2-retag`가 붙은 동안에만 켠다(CSS에서 `d` 전이를 못 하는 브라우저는
 * 지금처럼 즉시 맞춰진다 — 나빠지지 않는다).
 */

/** 열을 건너는 이동 시간(ms). 0.28초로는 무슨 일이 있었는지 안 읽힌다. */
export const RETAG_MS = 560;

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * 다음 배치 이동을 감속으로 그린다.
 *
 * 배치는 React가 다시 그린 뒤에 일어나므로 **미리** 걸어 두는 것이 맞다.
 * 겹쳐 부르면 창을 늘린다 — 연속으로 이으면 마지막 이동까지 느려야 한다.
 */
export function slowMove(ms: number = RETAG_MS): void {
  if (typeof document === "undefined") return;
  const stage = document.querySelector<HTMLElement>(".canvas2");
  if (!stage) return;
  stage.style.setProperty("--c2-move", `${ms}ms`);
  stage.setAttribute("data-c2-retag", "");
  if (timer) clearTimeout(timer);
  // 전이가 끝나고 나서 걷는다 — 도중에 걷으면 남은 거리를 툭 건너뛴다.
  timer = setTimeout(() => {
    timer = null;
    stage.style.removeProperty("--c2-move");
    stage.removeAttribute("data-c2-retag");
  }, ms + 120);
}
