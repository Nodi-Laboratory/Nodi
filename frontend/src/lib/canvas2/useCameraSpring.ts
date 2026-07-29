"use client";

/**
 * 카메라 스프링 (D124) — CSS transition을 대체한다.
 *
 * ## v1이 왜 튀었나
 *
 * v1은 `transition: transform 0.7s`로 카메라를 애니메이션하면서 추종 루프가
 * **매 rAF마다** setCamera를 했다. 새 transform이 커밋될 때마다 브라우저가
 * 0.7초 transition을 현재 보간 지점에서 재시작하므로, 실효 동작은 시정수
 * 0.7초짜리 지수 지연이었다. 목표를 계속 뒤따라가며 늘어지다가 시뮬레이션이
 * 멈추는 순간 마지막 커밋값까지 0.7초에 걸쳐 미끄러진다 — "따라오다 마지막에
 * 훅 간다"는 체감이 이것이다.
 *
 * ## 임계 감쇠 스프링
 *
 * 목표가 매 프레임 바뀌어도 튀지 않고, 오버슈트가 없으며, 언제 목표를 바꿔도
 * 속도가 연속이다. ζ=1(임계 감쇠)이라 진동하지 않는다.
 *
 *     a = -2ζω·v - ω²·(x - target),   ω = 2π/T
 *
 * ## 사용자 조작이 항상 이긴다
 *
 * 애니메이션 중 사용자가 팬/줌하면 **즉시 추종을 버린다.** 우리가 쓴 값과
 * 실제 카메라가 어긋나면 그건 사용자 입력이다. 이걸 안 하면 학생이 화면을
 * 옮기는데 카메라가 계속 되돌아오는 최악의 UX가 된다.
 */

import { useCallback, useEffect, useRef } from "react";
import type { Camera } from "./types";
import type { Bridge } from "./useExcalidrawBridge";

/** 목표 도달 시간(초) 대략치. 작을수록 빠르고 딱딱하다. */
const PERIOD = 0.42;
/** 이 이하로 가까워지면 정지. px(줌 1 기준) · 줌은 비율이라 별도 임계값. */
const EPS_SCROLL = 0.4;
const EPS_ZOOM = 0.002;
/** 사용자 조작 판정 임계 — 우리가 쓴 값과 이만큼 벌어지면 사람이 만진 것. */
const HIJACK_EPS = 1.5;
/** 한 프레임 최대 dt. 탭이 백그라운드였다 돌아올 때 폭주를 막는다. */
const MAX_DT = 1 / 30;

export interface CameraSpring {
  /** 목표를 정하고 추종을 시작한다. */
  flyTo: (target: Camera) => void;
  /** 즉시 이동(애니메이션 없음). */
  jumpTo: (target: Camera) => void;
  /** 추종 취소. */
  cancel: () => void;
}

export function useCameraSpring(bridge: Bridge): CameraSpring {
  // **bridge 객체 전체에 의존하면 안 된다.**
  //
  // bridge는 카메라가 바뀔 때마다 새 객체가 된다. 그걸 의존성에 넣으면
  //   applyCamera → setCamera → 새 bridge → jumpTo 새 함수 → 이펙트 재실행
  //   → applyCamera → …
  // 로 무한 루프가 된다(실측: "Maximum update depth exceeded").
  // api·cameraRef·applyCamera는 카메라 값과 무관하게 안정적이다.
  const { api, cameraRef, applyCamera } = bridge;
  const targetRef = useRef<Camera | null>(null);
  const velRef = useRef({ sx: 0, sy: 0, z: 0 });
  /** 마지막으로 **우리가** 쓴 카메라. 사용자 조작 감지에 쓴다. */
  const wroteRef = useRef<Camera | null>(null);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);

  const cancel = useCallback(() => {
    targetRef.current = null;
    velRef.current = { sx: 0, sy: 0, z: 0 };
    wroteRef.current = null;
  }, []);

  const jumpTo = useCallback(
    (target: Camera) => {
      cancel();
      applyCamera(target);
    },
    [applyCamera, cancel],
  );

  const flyTo = useCallback((target: Camera) => {
    targetRef.current = target;
    // 속도는 보존한다 — 연달아 flyTo를 부르면(추종 루프) 이어서 움직인다.
  }, []);

  useEffect(() => {
    if (!api) return;

    const step = (ts: number) => {
      rafRef.current = requestAnimationFrame(step);

      const target = targetRef.current;
      if (!target) {
        lastTsRef.current = ts;
        return;
      }

      const cur = cameraRef.current;

      // 사용자 조작 감지 — 우리가 쓴 값과 실제가 어긋났으면 사람이 만진 것이다.
      const wrote = wroteRef.current;
      if (
        wrote &&
        (Math.abs(wrote.scrollX - cur.scrollX) > HIJACK_EPS ||
          Math.abs(wrote.scrollY - cur.scrollY) > HIJACK_EPS ||
          Math.abs(wrote.zoom - cur.zoom) > EPS_ZOOM * 4)
      ) {
        cancel();
        lastTsRef.current = ts;
        return;
      }

      const dt = Math.min(MAX_DT, Math.max(0, (ts - lastTsRef.current) / 1000) || 0);
      lastTsRef.current = ts;
      if (dt <= 0) return;

      const w = (2 * Math.PI) / PERIOD;
      const v = velRef.current;

      const integrate = (x: number, target1: number, vel: number) => {
        const a = -2 * w * vel - w * w * (x - target1);
        const nv = vel + a * dt;
        return { x: x + nv * dt, v: nv };
      };

      const nx = integrate(cur.scrollX, target.scrollX, v.sx);
      const ny = integrate(cur.scrollY, target.scrollY, v.sy);
      const nz = integrate(cur.zoom, target.zoom, v.z);
      velRef.current = { sx: nx.v, sy: ny.v, z: nz.v };

      const done =
        Math.abs(nx.x - target.scrollX) < EPS_SCROLL &&
        Math.abs(ny.x - target.scrollY) < EPS_SCROLL &&
        Math.abs(nz.x - target.zoom) < EPS_ZOOM &&
        Math.abs(nx.v) < 40 &&
        Math.abs(ny.v) < 40;

      const next: Camera = done
        ? target
        : { scrollX: nx.x, scrollY: ny.x, zoom: nz.x };

      wroteRef.current = next;
      applyCamera(next);
      if (done) cancel();
    };

    lastTsRef.current = performance.now();
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [api, cameraRef, applyCamera, cancel]);

  return { flyTo, jumpTo, cancel };
}

/**
 * world의 사각형을 화면 중앙에 두는 카메라를 계산한다.
 *
 * v1의 `focusCamera`는 카드의 **top-left**를 중앙에 뒀고 높이는 상수
 * `CARD_CY = 200`으로 추정했다(ConceptCanvasWorkspace.tsx:29). 아이템 높이가
 * 가변인 v2에서는 그 방식이 카드마다 어긋난다 — 실제 사각형을 받는다.
 */
export function cameraForRect(
  rect: { x: number; y: number; w: number; h: number },
  viewport: { w: number; h: number },
  zoom: number,
): Camera {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    zoom,
    scrollX: viewport.w / 2 / zoom - cx,
    scrollY: viewport.h / 2 / zoom - cy,
  };
}
