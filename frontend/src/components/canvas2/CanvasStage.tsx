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
import type { Camera, ToolName } from "@/lib/canvas2/types";
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
          // 자식(아이템)이 pointer-events:auto를 켤지 여기서 정한다.
          ["--c2-item-events" as string]: overlayInteractive ? "auto" : "none",
        }}
      >
        {children}
      </div>

      {chrome}

      {!viewOnly && (
        <ToolRail
          active={activeTool}
          onSelect={bridge.setTool}
          onUndo={() => sendHistoryKey(false)}
          onRedo={() => sendHistoryKey(true)}
        />
      )}
    </div>
  );
}

/**
 * 실행 취소/다시 실행.
 *
 * **Excalidraw는 undo/redo를 공개 API로 노출하지 않는다** — `api.history`에는
 * `clear()`만 있다(문서 확인). 그래서 Excalidraw 자신의 키 처리 경로를 태운다.
 *
 * 두 가지를 지킨다:
 *   1. 먼저 캔버스에 포커스를 준다. Excalidraw는 포커스가 자기 밖에 있으면
 *      단축키를 무시한다(입력창에 타이핑하는 중에 도형이 지워지면 안 되니까).
 *   2. `document`에 올린다. Excalidraw의 리스너가 거기 붙어 있다.
 *
 * ⚠️ 이 경로는 합성 포인터 이벤트로 자동 검증할 수 없다(Excalidraw의 포인터
 * 파이프라인이 합성 이벤트를 받지 않아 되돌릴 그림을 만들 수 없다). 손으로
 * 확인해야 하고, Excalidraw를 올릴 때 함께 확인해야 한다. 학생에게는
 * `Ctrl/⌘+Z`가 항상 되는 경로이므로 이 버튼이 실패해도 막히지는 않는다.
 */
function sendHistoryKey(redo: boolean) {
  const canvas = document.querySelector<HTMLElement>(
    ".excalidraw__canvas.interactive",
  );
  const container = document.querySelector<HTMLElement>(".excalidraw");
  if (!container) return;

  // Excalidraw는 포커스가 자기 안에 없으면 단축키를 흘려보낸다.
  (canvas ?? container).focus?.();

  const ev = new KeyboardEvent("keydown", {
    key: "z",
    code: "KeyZ",
    // ⌘(mac) / Ctrl(그 외) — 둘 다 켜면 Excalidraw의 CTRL_OR_CMD 검사를 통과한다.
    ctrlKey: true,
    metaKey: true,
    shiftKey: redo,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(ev);
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

/** 아이템 루트에 얹는 공통 스타일 — 오버레이의 pointer-events 정책을 받는다. */
export const ITEM_BASE_STYLE: React.CSSProperties = {
  position: "absolute",
  pointerEvents: "var(--c2-item-events)" as React.CSSProperties["pointerEvents"],
};

export type { ToolName };
