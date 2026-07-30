"use client";

/**
 * 캔버스 셸 (D120) — 그리기 레이어 + 아이템 오버레이 + 도구 레일을 겹친다.
 *
 * ```
 * ┌─ .canvas2 (relative, overflow hidden) ───────────────────┐
 * │  ┌ DotGrid (변환 평면 안 — 팬을 따라간다) ─────────────┐ │
 * │  ┌ ExcalidrawLayer (팬/줌 소유, 그림 렌더) ────────────┐ │
 * │  ┌ .c2-overlay (pointer-events:none) ──────────────────┐ │
 * │  │   transform: translate(sx*z, sy*z) scale(z)          │ │
 * │  │   children: 아이템 · 연결선                           │ │
 * │  └──────────────────────────────────────────────────────┘ │
 * │  ToolRail · 상단/하단 UI  ← 화면 고정(변환 밖)            │
 * └───────────────────────────────────────────────────────────┘
 * ```
 *
 * 오버레이 컨테이너는 `pointer-events:none`이고 **아이템만** `auto`다.
 * 그리기 도구가 활성이면 아이템도 `none`이 되어 글 위에도 선을 그을 수 있다.
 */

import { useCallback, useEffect, useRef } from "react";
import type { DrawingScene } from "@/lib/api/canvas";
import type { Camera } from "@/lib/canvas2/types";
import type { Bridge } from "@/lib/canvas2/useExcalidrawBridge";
import {
  useCameraFrame,
  useMiddleDragPan,
  useWheelForwarding,
} from "@/lib/canvas2/useExcalidrawBridge";
import { ExcalidrawLayer } from "./ExcalidrawLayer";
import { ToolRail } from "./ToolRail";

/** 도트 그리드 간격(world px). 줌에 따라 화면상 간격이 변한다. */
const GRID = 28;
/** 이보다 작게 끌면 올가미가 아니라 클릭으로 본다(world px). */
const MARQUEE_MIN = 6;

interface Props {
  bridge: Bridge;
  initialScene: DrawingScene | null;
  /** 씬이 도착한 시점을 나타내는 키. 바뀌면 그리기 레이어만 리마운트된다. */
  sceneKey: string | null;
  /** 그리기 레이어 마운트 시 적용할 카메라. */
  initialCamera?: { scrollX: number; scrollY: number; zoom: number };
  onSceneCommit: (scene: DrawingScene) => void;
  /** 글쓰기 도구로 빈 캔버스를 클릭했을 때 — world 좌표를 준다. */
  onCanvasClick?: (world: { x: number; y: number }) => void;
  /** 그 외 도구로 빈 캔버스를 클릭했을 때 — 선택 해제용. */
  onBackgroundClick?: () => void;
  /**
   * 선택 도구로 빈 곳을 끌었을 때 — 그 world 사각형에 걸친 아이템을 고른다.
   * `add`면 기존 선택에 더한다(Shift).
   */
  onMarquee?: (rect: { x: number; y: number; w: number; h: number }, add: boolean) => void;
  viewOnly?: boolean;
  /** 화면 고정 UI(상단바·입력창 등) */
  chrome?: React.ReactNode;
  children: React.ReactNode;
}

export function CanvasStage({
  bridge,
  initialScene,
  sceneKey,
  initialCamera,
  onSceneCommit,
  onCanvasClick,
  onBackgroundClick,
  onMarquee,
  viewOnly = false,
  chrome,
  children,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const { activeTool, overlayInteractive, subscribeFrame, panByScreen } = bridge;

  useWheelForwarding(overlayRef, overlayInteractive);
  useMiddleDragPan(rootRef, panByScreen);

  /**
   * 오버레이 변환 — **React가 아니라 여기가 소유한다.**
   *
   * style prop으로 두면 팬 프레임마다 리렌더가 필요하고, 그 리렌더가 아이템
   * 트리와 미니맵을 통째로 다시 돌린다. 여기서 DOM을 직접 고치면 팬 중
   * React는 한 번도 돌지 않는다.
   */
  useCameraFrame(
    subscribeFrame,
    overlayRef,
    useCallback((el: HTMLElement, c: Camera) => {
      el.style.transform = `translate(${c.scrollX * c.zoom}px, ${
        c.scrollY * c.zoom
      }px) scale(${c.zoom})`;
    }, []),
  );

  // 격자도 같은 이유로 직접 고친다. 줌아웃이 심하면 점이 뭉쳐 회색 면이
  // 되므로 그 아래로는 숨긴다.
  useCameraFrame(
    subscribeFrame,
    gridRef,
    useCallback((el: HTMLElement, c: Camera) => {
      const step = GRID * c.zoom;
      el.style.opacity = step < 9 ? "0" : "1";
      el.style.backgroundSize = `${step}px ${step}px`;
      el.style.backgroundPosition = `${c.scrollX * c.zoom}px ${c.scrollY * c.zoom}px`;
    }, []),
  );

  // 빈 캔버스에서의 포인터.
  //
  //   글쓰기 도구  → 그 자리에 새 글을 만든다. Excalidraw가 먼저 먹지 않도록
  //                  **캡처 단계에서** 가로채고 전파를 끊는다.
  //   선택 도구    → 끌면 올가미(marquee), 그냥 누르면 선택 해제.
  //   그 외        → 아무것도 하지 않는다. 전파도 끊지 않는다(팬·그리기가
  //                  계속 돌아야 한다).
  const { toWorld } = bridge;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    /** 올가미 시작점(world). null이면 올가미 중이 아니다. */
    let from: { x: number; y: number } | null = null;

    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // 우리 UI(도구 레일·아이템) 위 클릭은 그쪽에 맡긴다.
      if (t.closest("[data-no-pan]") || t.closest("[data-canvas-item]")) return;
      // 왼쪽 버튼만. 중클릭은 팬(useMiddleDragPan)이 가져간다.
      if (e.button !== 0) return;

      if (activeTool === "note") {
        e.preventDefault();
        e.stopPropagation();
        onCanvasClick?.(toWorld(e.clientX, e.clientY, root.getBoundingClientRect()));
        return;
      }
      // 팬·그리기 중에는 선택을 건드리지 않는다 — 화면을 옮길 때마다 선택이
      // 풀리면 아이템을 고르고 이동해서 보려는 동작이 불가능하다.
      //
      // **전파는 끊지 않는다.** Excalidraw가 같은 드래그로 자기 도형을 올가미로
      // 잡아야 한다 — 그래야 도형과 글이 **한 번에** 묶인다(사용자 요구).
      // 올가미 사각형도 저쪽이 그린다. 우리가 하나 더 그리면 두 겹이 된다.
      if (activeTool === "selection") {
        from = toWorld(e.clientX, e.clientY, root.getBoundingClientRect());
      }
    };

    const onUp = (e: PointerEvent) => {
      const f = from;
      from = null;
      if (!f) return;
      const to = toWorld(e.clientX, e.clientY, root.getBoundingClientRect());
      const w = Math.abs(to.x - f.x);
      const h = Math.abs(to.y - f.y);
      // 끌지 않았으면 그냥 클릭이다 — 선택 해제.
      if (w < MARQUEE_MIN && h < MARQUEE_MIN) {
        onBackgroundClick?.();
        return;
      }
      onMarquee?.(
        { x: Math.min(f.x, to.x), y: Math.min(f.y, to.y), w, h },
        e.shiftKey,
      );
    };

    root.addEventListener("pointerdown", onDown, { capture: true });
    // window에서 받는다 — 캔버스 밖에서 손을 떼도 올가미가 끝나야 한다.
    window.addEventListener("pointerup", onUp, { capture: true });
    return () => {
      root.removeEventListener("pointerdown", onDown, { capture: true });
      window.removeEventListener("pointerup", onUp, { capture: true });
    };
  }, [activeTool, onCanvasClick, onBackgroundClick, onMarquee, toWorld]);

  return (
    <div
      ref={rootRef}
      className="canvas2 relative h-full w-full overflow-hidden"
      style={{ cursor: activeTool === "note" ? "text" : undefined }}
    >
      {/* 격자는 변환 평면 **밖**에 두고 background-position으로 흉내 낸다 —
          평면 안에 두면 scale(z)에 따라 점 자체가 커져 줌아웃에서 뭉개진다.
          위치·간격은 useCameraFrame이 DOM에 직접 쓴다. */}
      <div ref={gridRef} className="canvas2-grid" />

      <ExcalidrawLayer
        key={sceneKey ?? "none"}
        onApi={bridge.setApi}
        initialScene={initialScene}
        onSceneCommit={onSceneCommit}
        viewOnly={viewOnly}
        initialCamera={initialCamera}
      />

      <div
        ref={overlayRef}
        className="absolute inset-0"
        style={{
          pointerEvents: "none",
          // transform은 여기서 주지 않는다 — useCameraFrame이 소유한다.
          // React가 style로도 쓰면 팬 중 리렌더가 한 프레임 옛 값으로 되돌린다.
          transformOrigin: "0 0",
          // 팬/줌마다 합성 레이어를 다시 만들지 않게 미리 알린다.
          willChange: "transform",
          /**
           * **Excalidraw 캔버스가 z-index: 2다.** 우리 오버레이는 DOM에서 뒤에
           * 있지만 z-index가 없어서, 히트 테스트에서 캔버스가 아이템을 통째로
           * 덮었다 — 실제 마우스로는 글을 클릭할 수도, 끌 수도 없었다.
           *
           * 합성 이벤트(`el.dispatchEvent`)는 히트 테스트를 건너뛰므로 자동
           * 검증에서 이 문제가 드러나지 않았다. 진짜 마우스로 눌러 봐야 보인다.
           */
          zIndex: 3,
          // 자식(아이템)이 pointer-events:auto를 켤지 여기서 정한다.
          ["--c2-item-events" as string]: overlayInteractive ? "auto" : "none",
        }}
      >
        {children}
      </div>

      {chrome}

      {!viewOnly && (
        <ToolRail active={activeTool} onSelect={bridge.setTool} />
      )}
    </div>
  );
}


