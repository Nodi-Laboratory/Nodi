"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * D45: 좌/우 사이드바 리사이즈 + 접기/펼치기 + 러버밴드 자동접기.
 * - 경계 드래그로 폭 조절(min/max clamp).
 * - 폭이 min에 닿으면 멈추고(저항), 같은 방향 누적 오버슈트 > overshoot면 collapsed 스냅.
 * - 토글 또는 반대 드래그로 펼침. 폭·접힘 상태는 localStorage 영속.
 */
export interface ResizablePanelsConfig {
  storageKey: string;
  leftDefault?: number;
  rightDefault?: number;
  leftMin?: number;
  leftMax?: number;
  rightMin?: number;
  rightMax?: number;
  /** min을 넘어 더 끌어야 접히는 오버슈트 임계(px). */
  overshoot?: number;
}

interface PersistShape {
  leftW: number;
  rightW: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export interface ResizablePanels {
  leftW: number;
  rightW: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  startLeftDrag: (e: React.PointerEvent) => void;
  startRightDrag: (e: React.PointerEvent) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
}

export function useResizablePanels(
  cfg: ResizablePanelsConfig,
): ResizablePanels {
  const {
    storageKey,
    leftDefault = 260,
    rightDefault = 380,
    leftMin = 200,
    leftMax = 420,
    rightMin = 280,
    rightMax = 560,
    overshoot = 64,
  } = cfg;

  const [state, setState] = useState<PersistShape>({
    leftW: leftDefault,
    rightW: rightDefault,
    leftCollapsed: false,
    rightCollapsed: false,
  });

  // 마운트 시 localStorage 복원(SSR 안전: effect에서만 접근)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistShape>;
        // SSR 안전: 기본값으로 first paint 후 클라이언트에서 1회 복원(하이드레이션 불일치 방지).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState((s) => ({
          // 손상된 localStorage 값(NaN·문자열 등)이 NaN 폭을 만들지 않게 유한성 가드.
          leftW: clamp(safeNum(parsed.leftW, s.leftW), leftMin, leftMax),
          rightW: clamp(safeNum(parsed.rightW, s.rightW), rightMin, rightMax),
          leftCollapsed: !!parsed.leftCollapsed,
          rightCollapsed: !!parsed.rightCollapsed,
        }));
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, storageKey]);

  // 진행 중 드래그 정리 함수(언마운트 시 리스너 누수 방지).
  const cleanupRef = useRef<(() => void) | null>(null);

  const startDrag = useCallback(
    (side: "left" | "right", e: React.PointerEvent) => {
      e.preventDefault();
      cleanupRef.current?.();
      const cur = stateRef.current;
      const startX = e.clientX;
      const startW = side === "left" ? cur.leftW : cur.rightW;
      const startCollapsed =
        side === "left" ? cur.leftCollapsed : cur.rightCollapsed;
      const min = side === "left" ? leftMin : rightMin;
      const max = side === "left" ? leftMax : rightMax;

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        // 좌: 오른쪽으로 끌면 넓어짐(+dx). 우: 왼쪽으로 끌면 넓어짐(-dx).
        const delta = side === "left" ? dx : -dx;
        const baseW = startCollapsed ? 0 : startW;
        const raw = baseW + delta;
        if (startCollapsed) {
          if (raw > overshoot) {
            applyWidth(side, clamp(Math.max(raw, min), min, max), false, setState);
          }
          return;
        }
        if (raw >= min) {
          applyWidth(side, clamp(raw, min, max), false, setState);
        } else if (min - raw > overshoot) {
          applyWidth(side, startW, true, setState); // 러버밴드 접힘 스냅
        } else {
          applyWidth(side, min, false, setState);
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        cleanupRef.current = null;
      };
      cleanupRef.current = up;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [leftMin, leftMax, rightMin, rightMax, overshoot],
  );

  const startLeftDrag = useCallback(
    (e: React.PointerEvent) => startDrag("left", e),
    [startDrag],
  );
  const startRightDrag = useCallback(
    (e: React.PointerEvent) => startDrag("right", e),
    [startDrag],
  );

  const toggleLeft = useCallback(
    () => setState((s) => ({ ...s, leftCollapsed: !s.leftCollapsed })),
    [],
  );
  const toggleRight = useCallback(
    () => setState((s) => ({ ...s, rightCollapsed: !s.rightCollapsed })),
    [],
  );

  useEffect(() => () => cleanupRef.current?.(), []);

  return {
    leftW: state.leftW,
    rightW: state.rightW,
    leftCollapsed: state.leftCollapsed,
    rightCollapsed: state.rightCollapsed,
    startLeftDrag,
    startRightDrag,
    toggleLeft,
    toggleRight,
  };
}

function clamp(v: number, min: number, max: number): number {
  // 비유한 입력(NaN/Infinity)은 안전하게 min으로 — 깨진 폭 전파 차단.
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/** 유한 숫자만 통과, 아니면 fallback. 손상된 영속값 방어. */
function safeNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function applyWidth(
  side: "left" | "right",
  w: number,
  collapsed: boolean,
  setState: React.Dispatch<React.SetStateAction<PersistShape>>,
) {
  setState((s) => {
    if (side === "left") {
      if (s.leftW === w && s.leftCollapsed === collapsed) return s;
      return { ...s, leftW: w, leftCollapsed: collapsed };
    }
    if (s.rightW === w && s.rightCollapsed === collapsed) return s;
    return { ...s, rightW: w, rightCollapsed: collapsed };
  });
}
