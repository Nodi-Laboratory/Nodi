"use client";

/**
 * 세모·별 찍기 (사용자 지시 2026-08-09).
 *
 * Excalidraw에 없는 도형이라 **그리는 일도 우리 것**이다: 학생이 끄는 동안
 * 점선 상자를 보여 주고, 손을 떼면 그 상자에 꼭 맞는 닫힌 선을 씬에 넣는다
 * (`polyShapes.ts`).
 *
 * 미리보기가 상자인 이유: 끄는 동안 진짜 도형을 그리려면 매 프레임 씬을
 * 되쓰야 하는데, `updateScene({elements})`는 `replaceAllElements`라 **그리는
 * 중에 부르면 안 된다**(D176에서 획이 끊긴 그 문제다). 크기와 자리는 상자로
 * 충분히 말할 수 있다.
 *
 * 손가락도 같은 길로 온다 — `useTouchNavigate`는 도구가 선택·이동일 때만
 * 끼어들므로 여기와 겹치지 않는다.
 */

import { useEffect } from "react";
import { polygonPoints, type PolyKind } from "./polyShapes";
import { isPolyTool, type ToolName } from "./types";

/** 이보다 작으면 찍지 않는다 — 톡 누른 것을 도형으로 만들면 점이 쌓인다. */
const MIN_PX = 8;

export interface PolyStampArgs {
  rootRef: React.RefObject<HTMLElement | null>;
  activeTool: ToolName;
  toWorld: (cx: number, cy: number, box: DOMRect) => { x: number; y: number };
  /** world 상자에 꼭 맞는 도형을 씬에 넣는다. */
  onStamp: (kind: PolyKind, rect: { x: number; y: number; w: number; h: number }) => void;
}

export function usePolyStamp({ rootRef, activeTool, toWorld, onStamp }: PolyStampArgs): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !isPolyTool(activeTool)) return;
    const kind = activeTool as PolyKind;

    let from: { sx: number; sy: number; wx: number; wy: number } | null = null;
    let boxEl: HTMLDivElement | null = null;

    const showBox = () => {
      if (boxEl) return;
      boxEl = document.createElement("div");
      boxEl.setAttribute("data-poly-preview", kind);
      Object.assign(boxEl.style, {
        position: "fixed",
        zIndex: "40",
        pointerEvents: "none",
        border: "1.5px dashed var(--c-ink-faint)",
        borderRadius: "4px",
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.appendChild(boxEl);
    };
    const moveBox = (x: number, y: number) => {
      if (!boxEl || !from) return;
      boxEl.style.left = `${Math.min(from.sx, x)}px`;
      boxEl.style.top = `${Math.min(from.sy, y)}px`;
      boxEl.style.width = `${Math.abs(x - from.sx)}px`;
      boxEl.style.height = `${Math.abs(y - from.sy)}px`;
    };
    const hideBox = () => {
      boxEl?.remove();
      boxEl = null;
    };

    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // 우리 UI(도구 레일 등) 위에서는 시작하지 않는다. **아이템 위는 된다** —
      // 글 위에 도형을 겹쳐 그리는 것은 막을 이유가 없다.
      if (t.closest("[data-no-pan]")) return;
      if (e.button !== 0 || !e.isPrimary) return;
      const w = toWorld(e.clientX, e.clientY, root.getBoundingClientRect());
      from = { sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y };
      showBox();
      moveBox(e.clientX, e.clientY);
      // Excalidraw에는 선택 도구가 물려 있다 — 그대로 두면 이 드래그가
      // 올가미가 되어 엉뚱한 것이 선택된다.
      e.stopPropagation();
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      if (!from) return;
      e.stopPropagation();
      moveBox(e.clientX, e.clientY);
    };

    const onUp = (e: PointerEvent) => {
      if (!from) return;
      e.stopPropagation();
      const f = from;
      from = null;
      hideBox();
      const w = Math.abs(e.clientX - f.sx);
      const h = Math.abs(e.clientY - f.sy);
      if (w < MIN_PX || h < MIN_PX) return;
      const to = toWorld(e.clientX, e.clientY, root.getBoundingClientRect());
      onStamp(kind, {
        x: Math.min(f.wx, to.x),
        y: Math.min(f.wy, to.y),
        w: Math.abs(to.x - f.wx),
        h: Math.abs(to.y - f.wy),
      });
    };

    root.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("pointermove", onMove, { capture: true });
    window.addEventListener("pointerup", onUp, { capture: true });
    window.addEventListener("pointercancel", onUp, { capture: true });
    return () => {
      hideBox();
      root.removeEventListener("pointerdown", onDown, { capture: true });
      window.removeEventListener("pointermove", onMove, { capture: true });
      window.removeEventListener("pointerup", onUp, { capture: true });
      window.removeEventListener("pointercancel", onUp, { capture: true });
    };
  }, [activeTool, onStamp, rootRef, toWorld]);
}

/** 상자 → Excalidraw `line` 스켈레톤. 요소를 만드는 쪽이 이 모양으로 넘긴다. */
export function polySkeleton(
  kind: PolyKind,
  rect: { x: number; y: number; w: number; h: number },
  style: { strokeColor: string; strokeWidth: number; opacity: number; roughness: number },
) {
  return {
    type: "line" as const,
    x: rect.x,
    y: rect.y,
    points: polygonPoints(kind, rect.w, rect.h),
    ...style,
  };
}
