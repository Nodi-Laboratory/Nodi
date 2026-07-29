"use client";

/**
 * Excalidraw와 우리 오버레이 사이의 유일한 창구 (D120).
 *
 * **다른 파일은 Excalidraw API를 직접 만지지 않는다.** 여기 한 곳에 모아 두면
 * 버전을 올리거나 그리기 엔진을 바꿀 때 고칠 자리가 하나다.
 *
 * ## 왜 Excalidraw가 뷰포트를 소유하는가
 *
 * 팬/줌을 우리가 소유하면 두 입력계가 싸운다(스페이스 드래그·핀치·트랙패드
 * 관성이 양쪽에 다 있다). Excalidraw의 카메라는 이미 훌륭하므로 그쪽에
 * 맡기고, 우리 오버레이가 그 상태를 따라간다.
 *
 * ## 좌표 규약 (실측 확인 2026-07-30)
 *
 *     screen = (world + scroll) * zoom
 *     world  = screen / zoom - scroll
 *
 * 오버레이에 `translate(scrollX*zoom, scrollY*zoom) scale(zoom)`(origin 0 0)을
 * 걸고 자식을 `left:worldX; top:worldY`로 두면 정확히 일치한다
 * (실측: world(120,120) · scroll(0,−181.8) · zoom 1.1 → 화면 132/−68,
 *  계산값 132/−67.98).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Camera, Rect, ToolName } from "./types";
import { isDrawTool } from "./types";

/** 우리가 쓰는 것만 추린 Excalidraw API 표면. */
export interface ExcalidrawApi {
  getAppState: () => {
    scrollX: number;
    scrollY: number;
    zoom: { value: number };
    width: number;
    height: number;
  };
  getSceneElements: () => readonly ExcalidrawElementLike[];
  updateScene: (data: { appState?: Record<string, unknown> }) => void;
  setActiveTool: (tool: { type: string; locked?: boolean }) => void;
  scrollToContent?: (target?: unknown, opts?: unknown) => void;
  history?: { clear: () => void };
}

export interface ExcalidrawElementLike {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
}

const IDENTITY: Camera = { scrollX: 0, scrollY: 0, zoom: 1 };

/** 그림 요소를 장애물로 쓸 때 두르는 여백. 글이 선에 닿아 보이지 않게. */
export const OBSTACLE_PAD = 24;

export interface Bridge {
  api: ExcalidrawApi | null;
  setApi: (api: ExcalidrawApi | null) => void;
  /** 렌더용. 값이 바뀔 때만 새 객체가 된다. */
  camera: Camera;
  /** 리렌더 없이 최신 값을 읽는 용도(rAF 루프·드래그 계산). */
  cameraRef: React.RefObject<Camera>;
  activeTool: ToolName;
  setTool: (tool: ToolName) => void;
  /** 오버레이가 포인터 이벤트를 먹어야 하는가(선택/손 도구일 때만). */
  overlayInteractive: boolean;
  /** 그림 요소들의 바운딩 박스(패딩 포함) — 배치 엔진의 장애물. */
  getObstacles: () => Rect[];
  /** 카메라를 직접 설정(스프링·미니맵 이동용). */
  applyCamera: (c: Camera) => void;
  /** screen(클라이언트) 좌표 → world */
  toWorld: (clientX: number, clientY: number, rootRect: DOMRect) => { x: number; y: number };
}

export function useExcalidrawBridge(): Bridge {
  const [api, setApi] = useState<ExcalidrawApi | null>(null);
  const [camera, setCamera] = useState<Camera>(IDENTITY);
  const [activeTool, setActiveToolState] = useState<ToolName>("selection");
  const cameraRef = useRef<Camera>(IDENTITY);

  // 카메라는 onChange가 아니라 rAF 폴링으로 읽는다.
  //
  // onChange는 드래그 중 과도하게 터지고, 스크롤만 바뀌었을 때도 elements
  // 배열을 통째로 넘긴다(우리는 안 쓴다). 폴링은 프레임당 정확히 1회이고
  // 값이 그대로면 setState를 건너뛰므로 리렌더도 안 난다.
  useEffect(() => {
    if (!api) return;
    let raf = 0;
    const tick = () => {
      const s = api.getAppState();
      const prev = cameraRef.current;
      if (
        prev.scrollX !== s.scrollX ||
        prev.scrollY !== s.scrollY ||
        prev.zoom !== s.zoom.value
      ) {
        const next = { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value };
        cameraRef.current = next;
        setCamera(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [api]);

  const setTool = useCallback(
    (tool: ToolName) => {
      setActiveToolState(tool);
      // 'note'는 우리 도구다 — Excalidraw에는 선택 도구를 물려 두고
      // 캔버스 클릭을 오버레이가 가로챈다.
      api?.setActiveTool({ type: tool === "note" ? "selection" : tool });
    },
    [api],
  );

  const getObstacles = useCallback((): Rect[] => {
    if (!api) return [];
    const out: Rect[] = [];
    for (const el of api.getSceneElements()) {
      if (el.isDeleted) continue;
      // 음수 폭/높이(역방향으로 그린 도형)를 정규화한다 — 그대로 두면
      // 사각형 교차 판정이 전부 거짓이 되어 장애물이 무시된다.
      const x = el.width < 0 ? el.x + el.width : el.x;
      const y = el.height < 0 ? el.y + el.height : el.y;
      const w = Math.abs(el.width);
      const h = Math.abs(el.height);
      out.push({
        x: x - OBSTACLE_PAD,
        y: y - OBSTACLE_PAD,
        w: w + OBSTACLE_PAD * 2,
        h: h + OBSTACLE_PAD * 2,
      });
    }
    return out;
  }, [api]);

  const applyCamera = useCallback(
    (c: Camera) => {
      if (!api) return;
      api.updateScene({
        appState: { scrollX: c.scrollX, scrollY: c.scrollY, zoom: { value: c.zoom } },
      });
      // **ref와 state를 함께 올린다.**
      //
      // ref만 갱신하면 폴링 루프가 영영 차이를 못 본다 — 루프는 ref와 실제
      // Excalidraw 상태를 비교하는데, 우리가 방금 둘을 같게 만들어 놨기
      // 때문이다. 그러면 React state는 초기값에 머물고 오버레이가 카메라를
      // 따라가지 않는다(실측: 초기 카메라를 180,150으로 옮겼는데 오버레이
      // transform은 translate(0,0)에 멈춰 있었다).
      cameraRef.current = c;
      setCamera(c);
    },
    [api],
  );

  const toWorld = useCallback(
    (clientX: number, clientY: number, rootRect: DOMRect) => {
      const { scrollX, scrollY, zoom } = cameraRef.current;
      return {
        x: (clientX - rootRect.left) / zoom - scrollX,
        y: (clientY - rootRect.top) / zoom - scrollY,
      };
    },
    [],
  );

  const overlayInteractive = !isDrawTool(activeTool);

  return useMemo(
    () => ({
      api,
      setApi,
      camera,
      cameraRef,
      activeTool,
      setTool,
      overlayInteractive,
      getObstacles,
      applyCamera,
      toWorld,
    }),
    [api, camera, activeTool, setTool, overlayInteractive, getObstacles, applyCamera, toWorld],
  );
}

/**
 * 오버레이 위에서 굴린 휠을 Excalidraw 캔버스로 재발행한다.
 *
 * **React의 `onWheel`을 쓰면 안 된다.** React는 wheel 리스너를 passive로 붙여서
 * `preventDefault()`가 무시되고 콘솔에 경고가 뜬다("Unable to preventDefault
 * inside passive event listener"). 막지 못하면 페이지가 같이 스크롤된다.
 *
 * 오버레이 컨테이너는 `pointer-events:none`이지만 **자식에서 버블링된 wheel은
 * 받는다** — 컨테이너 한 곳에만 붙이면 되고 아이템마다 붙일 필요가 없다.
 *
 * 실측(2026-07-30): ctrl+휠 → zoom 1.00→1.10, 일반 휠 → scrollY 0→−227.
 */
export function useWheelForwarding(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    const onWheel = (e: WheelEvent) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        ".excalidraw__canvas.interactive",
      );
      if (!canvas) return;
      e.preventDefault();
      e.stopPropagation();
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, enabled]);
}
