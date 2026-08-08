"use client";

/**
 * 카드가 넓어질 수 있는 **한계 폭** (D210 3-2).
 *
 * ## 왜 실측인가
 *
 * "글자 수 × 상수"로 어림잡으면 크게 어긋난다 — 손글씨 폰트는 글자마다 폭이
 * 다르고, 한글·라틴·숫자·수식이 섞이면 그 차이가 누적된다. 게다가 굵게·
 * 형광펜 런은 자간까지 달라진다.
 *
 * 그래서 **실제로 그려 본다.** 본문을 그대로 복제해 줄바꿈을 끄고(`max-content`)
 * 그 폭을 읽는다. 복제본은 원본과 같은 부모에 붙여 폰트·자간·크기를 그대로
 * 물려받는다 — 다른 곳에 붙이면 `.canvas2 .hand` 규칙이 안 걸려 엉뚱한
 * 값이 나온다.
 */

/** 손잡이로 넓힐 수 있는 절대 상한(world px). 화면을 가로지르는 카드를 막는다. */
export const HARD_MAX_W = 2400;

/**
 * `body` 안의 **가장 긴 줄**이 줄바꿈 없이 들어가는 폭.
 *
 * 좌우 패딩은 호출부가 더한다 — 이 함수는 글이 차지하는 폭만 답한다.
 * 잴 수 없으면(요소가 아직 없음) `0`을 돌려주고, 호출부가 기본 상한을 쓴다.
 */
export function widestLineWidth(body: HTMLElement | null): number {
  if (!body || typeof document === "undefined") return 0;
  const parent = body.parentElement;
  if (!parent) return 0;

  const clone = body.cloneNode(true) as HTMLElement;
  Object.assign(clone.style, {
    position: "absolute",
    left: "-99999px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    // 줄바꿈을 끄는 것이 이 측정의 전부다.
    width: "max-content",
    maxWidth: "none",
    height: "auto",
  } satisfies Partial<CSSStyleDeclaration>);
  // 애니메이션 중인 글자 span이 복제되면 폭이 흔들린다 — 연출만 걷어낸다.
  for (const el of clone.querySelectorAll<HTMLElement>("[data-ink], .c2-math-in")) {
    el.classList.remove("c2-ink", "c2-tune", "c2-math-in");
  }
  parent.appendChild(clone);
  const w = clone.scrollWidth;
  parent.removeChild(clone);
  return w;
}

/**
 * 손잡이로 끌 때의 폭을 규칙 안으로 가둔다 (순수).
 *
 * `content`가 0이면(아직 못 잼) 기본 상한을 쓴다 — 못 쟀다고 못 늘리게
 * 하면 학생 눈에는 손잡이가 고장난 것으로 보인다.
 */
export function clampWidth(
  requested: number,
  { min, content, fallback }: { min: number; content: number; fallback: number },
): number {
  const max = Math.min(HARD_MAX_W, content > 0 ? Math.max(content, fallback) : fallback);
  return Math.min(max, Math.max(min, requested));
}
