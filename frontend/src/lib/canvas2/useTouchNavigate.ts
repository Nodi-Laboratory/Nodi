"use client";

/**
 * 손가락 캔버스 조작 (D208).
 *
 * ## 규칙 (사용자 지시 2026-08-07)
 *
 *   그냥 끌기   → **화면 이동.** 도구를 고르지 않아도 그렇게 된다.
 *   길게 누르기 → **선택 상자**가 나타나고, 그대로 끌어 담는다.
 *
 * PC도 **합친 도구에서는 같은 규칙**이다(사용자 지시 2026-08-09) — 선택 도구와
 * 화면 이동 도구를 하나로 합치면서, 끌기 하나가 두 뜻을 갖게 됐다. 다만 기다리는
 * 시간은 다르다(마우스 0.7초 · 손가락 0.42초): 마우스는 누르자마자 끄는 것이
 * 이동이라 짧게 잡으면 옮기려던 것이 자꾸 선택 상자가 된다.
 *
 * 손가락에 이 규칙이 필요했던 이유는 그대로다 — 휠도 중클릭도 없어서 PC의
 * 옛 규칙(끌기 = 올가미)을 쓰면 **화면을 옮길 방법이 사실상 없다.**
 *
 * ## 왜 우리가 직접 처리하나
 *
 * Excalidraw에 맡기면 "길게 누르면 선택으로 바뀐다"를 만들 수 없다. 저쪽은
 * 포인터가 닿는 순간 팬 제스처를 시작하고, 그 뒤에 성격을 바꿀 방법이 없다.
 * 그래서 **캡처 단계에서 먼저 가로채** 팬도 선택도 우리가 낸다.
 *
 * 가로채는 범위는 좁다 — 손가락·펜이고, 도구가 선택/화면 이동일 때, 그리고
 * 빈 캔버스를 눌렀을 때뿐이다. 그리기 도구와 아이템 드래그는 그대로 둔다.
 */

import { useEffect, useRef } from "react";
import type { Rect } from "./rect";

/** 손가락: 이만큼 누르고 있으면 선택 상자로 바뀐다(ms). */
const LONG_PRESS_MS = 420;

/**
 * 마우스: 이만큼(사용자 지시 2026-08-09).
 *
 * 손가락보다 길다. 마우스는 **누르자마자 끄는** 것이 화면 이동이라, 짧게
 * 잡으면 옮기려던 것이 자꾸 선택 상자가 된다. 0.7초는 "일부러 기다렸다"가
 * 되는 지점이다.
 */
const MOUSE_HOLD_MS = 700;
/** 이보다 움직이면 "누르고 있는 것"이 아니다(화면 px). */
const HOLD_SLOP = 10;
/** 이보다 작은 상자는 선택이 아니라 탭이다. */
const MARQUEE_MIN_PX = 8;

export interface TouchNavigateArgs {
  rootRef: React.RefObject<HTMLElement | null>;
  /** 지금 도구. 선택·화면 이동일 때만 끼어든다. */
  activeTool: string;
  /** 이 기기가 손가락 기기인가. 아니면 손가락 규칙은 안 쓴다. */
  enabled: boolean;
  /**
   * 마우스도 같은 규칙으로 다룰까 (사용자 지시 2026-08-09).
   *
   * 선택 도구와 화면 이동 도구를 **하나로 합치면서** 생긴 요구다. 도구가
   * 하나뿐이니 끌기 하나에 두 뜻을 담아야 한다 — 그냥 끌면 이동, 잠깐
   * 누르고 있다가 끌면 선택 상자. 손가락에서 이미 쓰던 규칙 그대로다(D208).
   */
  mouse?: boolean;
  /** 화면 픽셀만큼 화면을 민다. */
  panByScreen: (dx: number, dy: number) => void;
  /** 한 점을 붙든 채 배율을 곱한다 — 두 손가락 확대. */
  zoomAtScreen: (factor: number, cx: number, cy: number) => void;
  /** 화면 좌표 → world. */
  toWorld: (cx: number, cy: number, box: DOMRect) => { x: number; y: number };
  onMarquee?: (rect: Rect, additive: boolean) => void;
  /** 빈 곳을 그냥 톡 눌렀다 — 선택 해제. */
  onBackgroundClick?: () => void;
}

/** 우리가 끼어드는 도구. 그리기 도구는 그대로 저쪽에 맡긴다. */
const NAV_TOOLS = new Set(["selection", "hand"]);

export function useTouchNavigate({
  rootRef,
  activeTool,
  enabled,
  mouse = false,
  panByScreen,
  zoomAtScreen,
  toWorld,
  onMarquee,
  onBackgroundClick,
}: TouchNavigateArgs): void {
  /**
   * ⚠️ **제스처 상태는 이펙트 밖에 둔다** (2026-08-10).
   *
   * 처음에는 이펙트 안의 지역 변수였다. 그런데 카드를 짚으면 도구가 바뀌고
   * (글을 누르면 선택으로 자동 전환) 이펙트가 **다시 붙으면서 장부가
   * 초기화된다** — 첫 손가락이 지워져 두 번째가 "첫 번째"가 되고, 두 손가락
   * 확대가 카드 위에서만 안 먹었다(실측 2026-08-10: 빈 곳은 4배로 커지는데
   * 카드 위는 560 → 560).
   */
  const 손가락Ref = useRef<Map<number, { x: number; y: number }>>(new Map());
  const 핀치Ref = useRef<{ 거리: number } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || (!enabled && !mouse)) return;
    if (!NAV_TOOLS.has(activeTool)) return;

    /**
     * **두 손가락 확대** (사용자 지시 2026-08-10).
     *
     * ⚠️ 패드에서 확대가 **통째로 안 됐다**(실측: 빈 곳에서도 카드 위에서도
     * 배율이 안 변했다). D218이 배율 막대를 걷어내며 "배율은 휠·Ctrl+휠이
     * 맡는다"고 했는데 **패드에는 휠이 없다** — 확대할 방법이 하나도 없었다.
     *
     * Excalidraw에 맡길 수도 없다: 첫 손가락의 `pointerdown`을 우리가
     * 삼키므로(아래 `stopPropagation`) 저쪽은 제스처를 시작조차 못 한다.
     * 터치를 우리가 소유하기로 한 이상 **확대도 우리 일이다.**
     */
    const 손가락 = 손가락Ref.current;
    const 핀치Box = 핀치Ref;

    const 두점 = (): [{ x: number; y: number }, { x: number; y: number }] | null => {
      const v = [...손가락.values()];
      return v.length >= 2 ? [v[0], v[1]] : null;
    };
    const 사이 = (a: { x: number; y: number }, b2: { x: number; y: number }) =>
      Math.hypot(a.x - b2.x, a.y - b2.y);

    /** 지금 제스처. null이면 우리가 잡은 것이 없다. */
    let g: {
      id: number;
      sx: number;
      sy: number;
      lx: number;
      ly: number;
      wx: number;
      wy: number;
      moved: boolean;
      marquee: boolean;
      timer: number;
    } | null = null;

    /** 선택 상자. 필요할 때만 만든다 — 평소에 DOM을 하나 더 두지 않는다. */
    let boxEl: HTMLDivElement | null = null;
    const showBox = () => {
      if (boxEl) return;
      boxEl = document.createElement("div");
      boxEl.setAttribute("data-touch-marquee", "1");
      Object.assign(boxEl.style, {
        position: "fixed",
        zIndex: "40",
        pointerEvents: "none",
        border: "1.5px dashed var(--c-live)",
        background: "var(--c-live-wash)",
        borderRadius: "4px",
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.appendChild(boxEl);
    };
    const moveBox = (x: number, y: number) => {
      if (!boxEl || !g) return;
      boxEl.style.left = `${Math.min(g.sx, x)}px`;
      boxEl.style.top = `${Math.min(g.sy, y)}px`;
      boxEl.style.width = `${Math.abs(x - g.sx)}px`;
      boxEl.style.height = `${Math.abs(y - g.sy)}px`;
    };
    const hideBox = () => {
      boxEl?.remove();
      boxEl = null;
    };

    const onDown = (e: PointerEvent) => {
      const isMouse = e.pointerType === "mouse";
      if (!isMouse) {
        손가락.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const 둘 = 두점();
        if (둘) {
          // 두 번째가 닿았다 — 밀던 것을 접고 확대로 넘어간다. 확대하려던
          // 사람은 화면을 밀 뜻이 없었다.
          if (g) {
            window.clearTimeout(g.timer);
            g = null;
          }
          hideBox();
          핀치Box.current = { 거리: 사이(둘[0], 둘[1]) };
          e.stopPropagation();
          return;
        }
      }
      /**
       * 마우스는 **합친 도구일 때만** 우리가 가져간다.
       *
       * 선택 도구가 켜져 있으면(글을 눌러 자동 전환된 상태) 끌기는 그냥
       * 올가미다 — 그건 `CanvasStage`가 이미 처리하고, Excalidraw가 자기
       * 도형을 같은 드래그로 잡아야 하므로 가로채면 안 된다.
       */
      if (isMouse && !(mouse && activeTool === "hand")) return;
      if (!isMouse && !enabled) return;
      // 가운데 버튼 끌기는 팬 전용이다(`useMiddleDragPan`).
      if (isMouse && e.button !== 0) return;
      if (!e.isPrimary) return;
      const t = e.target as HTMLElement;
      // 우리 UI·아이템 위는 그쪽 일이다(버튼·카드 드래그).
      if (t.closest("[data-no-pan]") || t.closest("[data-canvas-item]")) return;

      const w = toWorld(e.clientX, e.clientY, root.getBoundingClientRect());
      g = {
        id: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        lx: e.clientX,
        ly: e.clientY,
        wx: w.x,
        wy: w.y,
        moved: false,
        marquee: false,
        timer: window.setTimeout(
          () => {
            if (!g || g.moved) return;
            g.marquee = true;
            showBox();
            moveBox(g.lx, g.ly);
          },
          isMouse ? MOUSE_HOLD_MS : LONG_PRESS_MS,
        ),
      };
      // Excalidraw가 자기 팬 제스처를 시작하지 못하게 한다.
      e.stopPropagation();
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" && 손가락.has(e.pointerId)) {
        손가락.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (핀치Box.current) {
        const 둘 = 두점();
        if (!둘) return;
        const 지금 = 사이(둘[0], 둘[1]);
        // 아주 작은 흔들림은 무시한다 — 손가락은 가만히 있어도 떨린다.
        if (지금 > 4 && Math.abs(지금 - 핀치Box.current.거리) > 1.5) {
          zoomAtScreen(
            지금 / 핀치Box.current.거리,
            (둘[0].x + 둘[1].x) / 2,
            (둘[0].y + 둘[1].y) / 2,
          );
          핀치Box.current.거리 = 지금;
        }
        e.stopPropagation();
        return;
      }
      if (!g || e.pointerId !== g.id) return;
      e.stopPropagation();
      const dx = e.clientX - g.lx;
      const dy = e.clientY - g.ly;
      if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > HOLD_SLOP) {
        g.moved = true;
        window.clearTimeout(g.timer);
      }
      g.lx = e.clientX;
      g.ly = e.clientY;
      if (g.marquee) {
        moveBox(e.clientX, e.clientY);
        return;
      }
      if (g.moved) panByScreen(dx, dy);
    };

    const onUp = (e: PointerEvent) => {
      손가락.delete(e.pointerId);
      if (핀치Box.current && 손가락.size < 2) {
        핀치Box.current = null;
        // 남은 손가락으로 곧장 밀기 시작하지 않는다 — 확대를 끝내는 동작의
        // 꼬리로 화면이 튀면 어지럽다. 다음 `pointerdown`부터 다시 센다.
        return;
      }
      if (!g || e.pointerId !== g.id) return;
      e.stopPropagation();
      window.clearTimeout(g.timer);
      const cur = g;
      g = null;
      hideBox();

      if (cur.marquee) {
        const to = toWorld(e.clientX, e.clientY, root.getBoundingClientRect());
        const w = Math.abs(e.clientX - cur.sx);
        const h = Math.abs(e.clientY - cur.sy);
        // 길게 눌렀다가 끌지 않고 뗐다 — 상자가 없으니 선택할 것도 없다.
        if (w < MARQUEE_MIN_PX && h < MARQUEE_MIN_PX) return;
        onMarquee?.(
          {
            x: Math.min(cur.wx, to.x),
            y: Math.min(cur.wy, to.y),
            w: Math.abs(to.x - cur.wx),
            h: Math.abs(to.y - cur.wy),
          },
          false,
        );
        return;
      }
      // 움직이지 않았으면 톡 누른 것이다 — 선택을 푼다.
      if (!cur.moved) onBackgroundClick?.();
    };

    root.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("pointermove", onMove, { capture: true });
    window.addEventListener("pointerup", onUp, { capture: true });
    window.addEventListener("pointercancel", onUp, { capture: true });
    return () => {
      if (g) window.clearTimeout(g.timer);
      hideBox();
      root.removeEventListener("pointerdown", onDown, { capture: true });
      window.removeEventListener("pointermove", onMove, { capture: true });
      window.removeEventListener("pointerup", onUp, { capture: true });
      window.removeEventListener("pointercancel", onUp, { capture: true });
    };
  }, [activeTool, enabled, mouse, onBackgroundClick, onMarquee, panByScreen, rootRef, toWorld, zoomAtScreen]);
}
