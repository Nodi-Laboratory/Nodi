"use client";

/**
 * 크롬 자리 잡기를 화면에 붙인다 (사용자 지시 2026-08-08).
 *
 * 규칙은 `chromeFit.ts`(순수 함수)가 갖고, 여기서는 **재서 넣고 결과를 나눠
 * 준다**. 도구바·미니맵·입력창은 서로 형제라 공통 부모를 거치지 않으면 못
 * 만나므로, 결과를 모듈 전역으로 흘린다(`dragBus`와 같은 사정).
 *
 * ⚠️ **잰 값을 의존성에 넣지 않는다.** 그러면 `setState`가 재는 함수의 신원을
 * 바꾸고 그 이펙트가 다시 돌아 무한 루프가 된다 — `useRailAvoid`에서 이미
 * 겪었다(D211 9).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fitChrome, type ChromeFit, type MapCorner } from "./chromeFit";
import { SNAP_MARGIN } from "./cornerSnap";

/** 크롬끼리 남길 틈(px). 붙어 있으면 한 덩어리로 보인다. */
const GAP = 14;

const NONE: ChromeFit = {
  railMode: "center",
  railShift: 0,
  mapDx: 0,
  askDx: 0,
  askMaxW: null,
};

type Listener = (f: ChromeFit) => void;
const listeners = new Set<Listener>();
let current: ChromeFit = NONE;

export function getChromeFit(): ChromeFit {
  return current;
}

export function subscribeChromeFit(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function publish(next: ChromeFit): void {
  if (
    next.railMode === current.railMode &&
    Math.abs(next.railShift - current.railShift) < 0.5 &&
    Math.abs(next.mapDx - current.mapDx) < 0.5 &&
    Math.abs(next.askDx - current.askDx) < 0.5 &&
    next.askMaxW === current.askMaxW
  ) {
    return;
  }
  current = next;
  for (const cb of listeners) cb(next);
}

/**
 * 도구바가 자기 크기를 재서 규칙을 돌린다.
 *
 * 재는 쪽이 도구바인 이유: 셋 중 **크기가 상황마다 달라지는 것**이 도구바다
 * (도구 수·접힘·팔레트). 지도와 입력창은 정해진 크기라 상수로 넘길 수 있다.
 */
export function useChromeFit(
  corner: MapCorner | null,
): readonly [(el: HTMLElement | null) => void, ChromeFit] {
  const [fit, setFit] = useState<ChromeFit>(NONE);
  const elRef = useRef<HTMLElement | null>(null);
  const obsRef = useRef<ResizeObserver | null>(null);
  const cornerRef = useRef(corner);
  /** 지금 적용된 값 — 재는 기준이다(state를 읽으면 위 루프가 된다). */
  const fitRef = useRef<ChromeFit>(NONE);

  const measure = useCallback(() => {
    const el = elRef.current;
    const stageEl = document.querySelector<HTMLElement>(".canvas2");
    const mapEl = document.querySelector<HTMLElement>("[data-minimap]");
    /**
     * 지도가 접혀 있어도 **문은 늘 오른쪽 위에 있다** (2026-08-09).
     *
     * 예전에는 `[data-minimap]`만 찾았다. 미니맵을 닫으면 그 표시가 사라지므로
     * 규칙이 "지도가 없다"고 보고 아무것도 안 했는데, 그 자리에는 지도로 나가는
     * 문(`MapDoor`, 140%에서 101×101)이 그대로 서 있다 — 도구바가 그 밑으로
     * 파고들었다.
     *
     * 실측 2026-08-09(1440×900): 문 y 16..117 · 도구바 y 95..806 — **22px**이
     * 겹쳤고 도구바의 접기 버튼이 문 아래에 깔렸다. 화면에서는 둘이 한 덩어리로
     * 보여서 "지도 버튼이 잘렸다"로 읽힌다.
     *
     * 문은 자리가 고정(`right-4 top-4`)이라 모서리도 늘 `tr`이다.
     */
    const doorEl = mapEl
      ? null
      : document.querySelector<HTMLElement>("[data-map-door]");
    const 장애물 = mapEl ?? doorEl;
    const askEl = document.querySelector<HTMLElement>("[data-ask-bar]");
    if (!el || !stageEl) return;
    const stage = stageEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const m = 장애물?.getBoundingClientRect();
    const a = askEl?.getBoundingClientRect();
    const next = fitChrome({
      stage: { w: stage.width, h: stage.height },
      corner: mapEl ? cornerRef.current : doorEl ? "tr" : null,
      // 지도도 문도 없으면 규칙이 어차피 아무것도 안 한다.
      map: { w: m?.width ?? 0, h: m?.height ?? 0 },
      // **비켜서기 전 크기**로 잰다 — 지금 밀린 값은 크기를 안 바꾸므로 그대로다.
      rail: { w: r.width, h: r.height },
      askW: a?.width ?? 0,
      margin: SNAP_MARGIN,
      gap: GAP,
      // 상단 바는 캔버스 위에 떠 있다 — 위 모서리의 지도가 그만큼 내려 앉는다.
      topInset:
        document
          .querySelector<HTMLElement>("[data-canvas-crumb]")
          ?.getBoundingClientRect().height ?? 0,
    });
    if (
      next.railMode === fitRef.current.railMode &&
      Math.abs(next.railShift - fitRef.current.railShift) < 0.5 &&
      Math.abs(next.mapDx - fitRef.current.mapDx) < 0.5 &&
      Math.abs(next.askDx - fitRef.current.askDx) < 0.5 &&
      next.askMaxW === fitRef.current.askMaxW
    ) {
      return;
    }
    fitRef.current = next;
    setFit(next);
    publish(next);
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

  useEffect(() => {
    cornerRef.current = corner;
    measure();
  }, [corner, measure]);

  // 창 크기가 바뀌면 다시 잰다 — 화면이 낮아지는 순간이 이 규칙이 필요한 때다.
  useEffect(() => {
    const on = () => measure();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [measure]);

  useEffect(() => () => obsRef.current?.disconnect(), []);

  return [attach, fit] as const;
}

/** 도구바 밖(미니맵·입력창)에서 결과만 받아 쓴다. */
export function useChromeFitValue(): ChromeFit {
  const [fit, setFit] = useState<ChromeFit>(getChromeFit);
  useEffect(() => subscribeChromeFit(setFit), []);
  return fit;
}
