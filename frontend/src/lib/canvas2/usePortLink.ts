"use client";

/**
 * 포트에서 끌어 잇는 제스처 (D210 4-3).
 *
 * 포인터를 잡고 도는 동안 **React를 거치지 않는다** — 미리보기 선은 DOM에
 * 직접 그리고, 놓는 순간에만 저장을 부른다. 드래그 중 setState하면 카드가
 * 많은 캔버스에서 곧바로 버벅인다(D124·D147과 같은 이유).
 */

import { useCallback, useEffect, useRef } from "react";
import type { PortDragStart } from "@/components/canvas2/PortHandles";

export interface PortLinkArgs {
  /** 화면 좌표 → world. */
  toWorld: (cx: number, cy: number) => { x: number; y: number };
  /** 그 world 좌표에 있는 카드 id (없으면 null). */
  cardAt: (world: { x: number; y: number }) => string | null;
  /** 이었다. `parentId`가 `childId`의 부모가 된다. */
  onLink: (parentId: string, childId: string) => void;
  /** 이 카드에 저 카드를 부모로 붙일 수 있나(순환·자기 자신 방지). */
  canLink: (parentId: string, childId: string) => boolean;
  /**
   * 아무 일도 안 일어났을 때 **왜인지** 알린다 (D211 2).
   *
   * 빈 곳에 놓거나 순환이 되는 곳에 놓으면 조용히 끝났다. 학생 눈에는
   * "연결 드래그가 안 된다"와 구분이 안 된다 — 실제로 그렇게 보고됐다.
   */
  onNothing?: (reason: string) => void;
}

export interface PortLinkResult {
  begin: (start: PortDragStart, e: React.PointerEvent) => void;
}

/** 미리보기 선을 담을 SVG. 필요할 때 만들고 끝나면 지운다. */
function ensureGhost(): SVGPathElement {
  let svg = document.querySelector<SVGSVGElement>("[data-port-ghost]");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-port-ghost", "1");
    Object.assign(svg.style, {
      position: "fixed",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: "45",
    } satisfies Partial<CSSStyleDeclaration>);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "var(--c-live)");
    path.setAttribute("stroke-width", "2.4");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-dasharray", "8 6");
    svg.appendChild(path);
    document.body.appendChild(svg);
  }
  return svg.querySelector("path")!;
}

function dropGhost(): void {
  document.querySelector("[data-port-ghost]")?.remove();
}

/** 지금 노리고 있는 카드를 밝힌다. 끌기가 끝나면 걷는다. */
function aim(id: string | null): void {
  for (const el of document.querySelectorAll("[data-port-aim]")) {
    if (el.getAttribute("data-canvas-item") !== id) el.removeAttribute("data-port-aim");
  }
  if (!id) return;
  document
    .querySelector(`[data-canvas-item="${CSS.escape(id)}"]`)
    ?.setAttribute("data-port-aim", "1");
}

export function usePortLink({
  toWorld,
  cardAt,
  onLink,
  canLink,
  onNothing,
}: PortLinkArgs): PortLinkResult {
  /** 콜백을 ref로 — 창구는 한 번만 만들고 최신 값을 읽는다. */
  const argsRef = useRef({ toWorld, cardAt, onLink, canLink, onNothing });
  // 렌더 중 ref 쓰기는 React Compiler가 막는다 — 이펙트에서 맞춘다.
  useEffect(() => {
    argsRef.current = { toWorld, cardAt, onLink, canLink, onNothing };
  }, [toWorld, cardAt, onLink, canLink, onNothing]);

  const begin = useCallback((start: PortDragStart, e: React.PointerEvent) => {
    const from = { x: e.clientX, y: e.clientY };
    const path = ensureGhost();

    const move = (ev: PointerEvent) => {
      // 화면 좌표로 그린다 — 캔버스 변환을 따라갈 필요가 없다(고정 오버레이).
      const mid = (from.y + ev.clientY) / 2;
      path.setAttribute(
        "d",
        `M ${from.x} ${from.y} C ${from.x} ${mid}, ${ev.clientX} ${mid}, ${ev.clientX} ${ev.clientY}`,
      );
      /**
       * **놓을 자리를 미리 밝힌다** (D211 2).
       *
       * 놓기 전에는 어디에 붙을지 알 수 없었다 — 빗나간 채로 놓고 "안 된다"고
       * 읽는 일이 그래서 생긴다. 붙을 수 없는 카드는 밝히지 않는다: 밝은데
       * 안 되는 것이 안 밝은 것보다 나쁘다.
       */
      const a = argsRef.current;
      const over = a.cardAt(a.toWorld(ev.clientX, ev.clientY));
      const p = start.role === "parent" ? start.id : over;
      const c = start.role === "parent" ? over : start.id;
      aim(over && over !== start.id && p && c && a.canLink(p, c) ? over : null);
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      dropGhost();
      aim(null);
      const a = argsRef.current;
      const world = a.toWorld(ev.clientX, ev.clientY);
      const hit = a.cardAt(world);
      if (!hit || hit === start.id) {
        a.onNothing?.("빈 곳에 놓았어요. 이을 카드 위에 놓아 주세요.");
        return;
      }
      /**
       * 끈 쪽이 어느 자리였나가 방향을 정한다.
       *
       *   아래 점에서 끌었다 → 시작 카드가 부모
       *   위 점에서 끌었다   → 시작 카드가 자식
       */
      const parentId = start.role === "parent" ? start.id : hit;
      const childId = start.role === "parent" ? hit : start.id;
      if (!a.canLink(parentId, childId)) {
        a.onNothing?.("그렇게는 이을 수 없어요(자기 자신이나 아래 가지예요).");
        return;
      }
      a.onLink(parentId, childId);
    };

    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    move(e.nativeEvent);
  }, []);

  return { begin };
}
