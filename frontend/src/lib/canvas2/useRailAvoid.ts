"use client";

/**
 * 미니맵을 피해 도구바가 비켜서는 양 (D211 9).
 *
 * 미니맵이 오른쪽 위/아래 모서리에 붙으면 도구바와 같은 변을 쓰게 된다.
 * 화면이 낮을수록 겹치고, 겹치면 둘 다 못 쓴다.
 *
 * ## 상수로 밀지 않고 **재서** 민다
 *
 * "80px쯤 내리면 되겠지"로 두면 화면이 큰 곳에서는 겹치지도 않는데 도구바가
 * 괜히 움직이고, 낮은 곳에서는 그래도 겹친다. 겹친 만큼만 민다 — 안 겹치면
 * 0이라 아무 일도 안 일어난다.
 *
 * ## 재는 자리는 ref 콜백이다
 *
 * 이펙트 본문의 setState는 React Compiler가 막는다. `ResizeObserver`가 처음
 * 한 번도 불러 주므로 초기값도 거기서 온다(`MiniMapOverlay`와 같은 방식).
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** 미니맵과 도구바 사이에 남길 틈(px). 붙어 있으면 둘이 한 덩어리로 보인다. */
const GAP = 14;

/**
 * `[컨테이너에 달 ref 콜백, 비켜설 양(px)]`.
 *
 * ⚠️ **객체로 묶어 돌려주면 안 된다.** React Compiler가 ref 콜백을 담은 객체
 * 전체를 ref로 보고, 같이 담긴 `shift`를 렌더에서 읽는 것까지 막는다
 * (실측 2026-08-08: `Cannot access refs during render`). 튜플로 갈라 두면
 * 구조 분해된 값은 그냥 값이다.
 *
 * @param corner 미니맵이 붙어 있는 모서리. 닫혀 있으면 null.
 */
export function useRailAvoid(
  corner: "tr" | "br" | "bl" | "tl" | null,
): readonly [(el: HTMLElement | null) => void, number] {
  const [shift, setShift] = useState(0);
  /**
   * 지금 밀려 있는 양 — **재는 기준**이다.
   *
   * ⚠️ state를 기준으로 삼고 `measure`의 의존성에 넣으면 무한 루프가 된다:
   * `setShift`가 `measure`의 신원을 바꾸고, 그 `measure`를 의존하는 이펙트가
   * 다시 돌아 또 잰다(실측 2026-08-08: `Maximum update depth exceeded`가 뜨고
   * 비켜선 양이 34 대신 11.8에서 멈췄다).
   */
  const shiftRef = useRef(0);
  const elRef = useRef<HTMLElement | null>(null);
  const obsRef = useRef<ResizeObserver | null>(null);
  const cornerRef = useRef(corner);

  const measure = useCallback(() => {
    const el = elRef.current;
    const map = document.querySelector<HTMLElement>("[data-minimap]");
    const c = cornerRef.current;
    const next = (() => {
      // 오른쪽 변을 함께 쓰는 두 자리에서만 비켜선다.
      if (!el || !map || (c !== "tr" && c !== "br")) return 0;
      const m = map.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      // **비켜서기 전의 자리**로 되돌려 잰다 — 지금 밀린 값을 안 빼면 잴 때마다
      // 조금씩 더 밀린다.
      const top = r.top - shiftRef.current;
      const bottom = r.bottom - shiftRef.current;
      return c === "tr"
        ? Math.max(0, m.bottom + GAP - top)
        : -Math.max(0, bottom + GAP - m.top);
    })();
    if (Math.abs(shiftRef.current - next) < 0.5) return;
    shiftRef.current = next;
    setShift(next);
  }, []);

  const attach = useCallback(
    (el: HTMLElement | null) => {
      elRef.current = el;
      obsRef.current?.disconnect();
      obsRef.current = null;
      if (!el) return;
      const ro = new ResizeObserver(() => measure());
      ro.observe(el);
      obsRef.current = ro;
    },
    [measure],
  );

  // 모서리가 바뀌면 다시 잰다 — 이벤트가 아니라 값이 바뀐 것이므로 여기서 본다.
  useEffect(() => {
    cornerRef.current = corner;
    measure();
  }, [corner, measure]);

  useEffect(() => () => obsRef.current?.disconnect(), []);

  return [attach, shift] as const;
}
