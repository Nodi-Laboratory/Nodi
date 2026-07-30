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

import { useEffect, useRef } from "react";
import type { DrawingScene } from "@/lib/api/canvas";
import type { Camera } from "@/lib/canvas2/types";
import type { Bridge } from "@/lib/canvas2/useExcalidrawBridge";
import { useWheelForwarding } from "@/lib/canvas2/useExcalidrawBridge";
import { ExcalidrawLayer } from "./ExcalidrawLayer";
import { ToolRail } from "./ToolRail";

/** 도트 그리드 간격(world px). 줌에 따라 화면상 간격이 변한다. */
const GRID = 28;

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
  viewOnly = false,
  chrome,
  children,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const { camera, activeTool, overlayInteractive } = bridge;

  useWheelForwarding(overlayRef, overlayInteractive);

  // 빈 캔버스 클릭.
  //
  //   글쓰기 도구  → 그 자리에 새 글을 만든다. Excalidraw가 먼저 먹지 않도록
  //                  **캡처 단계에서** 가로채고 전파를 끊는다.
  //   그 외        → 선택 해제만. 전파는 끊지 않는다(팬·그리기가 계속 돌아야 한다).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // 우리 UI(도구 레일·아이템) 위 클릭은 그쪽에 맡긴다.
      if (t.closest("[data-no-pan]") || t.closest("[data-canvas-item]")) return;

      if (activeTool === "note") {
        e.preventDefault();
        e.stopPropagation();
        onCanvasClick?.(bridge.toWorld(e.clientX, e.clientY, root.getBoundingClientRect()));
        return;
      }
      // 팬·그리기 중에는 선택을 건드리지 않는다 — 화면을 옮길 때마다 선택이
      // 풀리면 아이템을 고르고 이동해서 보려는 동작이 불가능하다.
      if (activeTool === "selection") onBackgroundClick?.();
    };

    root.addEventListener("pointerdown", onDown, { capture: true });
    return () => root.removeEventListener("pointerdown", onDown, { capture: true });
  }, [activeTool, onCanvasClick, onBackgroundClick, bridge]);

  return (
    <div
      ref={rootRef}
      className="canvas2 relative h-full w-full overflow-hidden"
      style={{ cursor: activeTool === "note" ? "text" : undefined }}
    >
      <DotGrid camera={camera} />

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
          transform: `translate(${camera.scrollX * camera.zoom}px, ${
            camera.scrollY * camera.zoom
          }px) scale(${camera.zoom})`,
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

/**
 * 도트 그리드. **변환 평면 밖**에 두고 background-position으로 흉내 낸다 —
 * 평면 안에 두면 scale(z)에 따라 점 자체가 커져서 줌아웃 시 뭉개진다.
 * 점 크기는 고정, 간격만 줌에 비례하는 게 제도지의 감각이다.
 */
function DotGrid({ camera }: { camera: Camera }) {
  const step = GRID * camera.zoom;
  // 줌아웃이 심하면 점이 뭉쳐 회색 면이 된다 — 그 아래로는 숨긴다.
  if (step < 9) return null;
  return (
    <div
      className="canvas2-grid"
      style={{
        backgroundSize: `${step}px ${step}px`,
        backgroundPosition: `${camera.scrollX * camera.zoom}px ${
          camera.scrollY * camera.zoom
        }px`,
      }}
    />
  );
}

