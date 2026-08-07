"use client";

/**
 * 손가락으로 쓰는 기기인가 (D208).
 *
 * ## 왜 필요한가
 *
 * PC와 태블릿은 **같은 동작에 다른 뜻**을 준다.
 *
 *   PC     끌기 = 올가미(선택). 화면 이동은 휠·중클릭·화면 이동 도구.
 *   태블릿 끌기 = 화면 이동. 손가락으로는 휠도 중클릭도 없다.
 *
 * 태블릿에서 PC 규칙을 그대로 쓰면 **화면을 옮길 방법이 사실상 없다** —
 * 도구 레일에서 손 아이콘을 먼저 누르지 않으면 끌 때마다 선택 상자만 나온다
 * (사용자 보고 2026-08-07). 그래서 기본 도구와 끌기의 뜻을 기기에 맞춘다.
 *
 * ## 왜 `pointer: coarse`인가
 *
 * 화면 폭으로 가르면 틀린다 — 12.9인치 태블릿은 웬만한 노트북보다 넓고,
 * 창을 좁힌 데스크톱은 마우스를 쓴다. 물어야 할 것은 크기가 아니라
 * **가리키는 장치의 정밀도**다.
 *
 * ⚠️ 펜(스타일러스)도 `coarse`로 온다. 그래도 맞는 판정이다 — 펜으로 쓰는
 * 기기에는 휠도 중클릭도 없다.
 */

import { useEffect, useState } from "react";

const QUERY = "(pointer: coarse)";

/** SSR·구형 브라우저에서는 **PC로 친다**(지금까지의 동작 그대로). */
export function isCoarsePointer(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * 기기 종류를 따라간다.
 *
 * 처음 렌더는 **언제나 false**다. 서버가 그린 것과 다르면 hydration이 깨지고,
 * 그러면 캔버스가 통째로 안 뜬다 — 도구 하나 때문에 화면을 잃을 수는 없다.
 * 붙자마자 실제 값으로 맞춘다.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(QUERY);
    const read = () => setCoarse(mq.matches);
    read();
    // 태블릿에 키보드·마우스를 붙였다 떼면 바뀐다.
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return coarse;
}
