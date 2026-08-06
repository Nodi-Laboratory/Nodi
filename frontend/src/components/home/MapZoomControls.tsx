"use client";

/**
 * 지도 확대 손잡이 (D191).
 *
 * 휠만으로도 되지만 **버튼이 있어야 하는 이유는 따로 있다** — 지금까지는 지도를
 * 확대하는 곳이 어디인지 화면에 아무 표시도 없어서, 학생이 브라우저를 확대해
 * 놓고 되돌리려다 지도를 줄였다(사용자 보고 2026-08-06). 버튼은 "여기가 지도의
 * 배율"이라고 말한다. 휠 없는 환경에서도 되는 것은 덤이다.
 */

import { Maximize2, Minus, Plus } from "lucide-react";

export interface MapZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** 보이는 개념 전부가 들어오게 맞춘다 — 숨긴 자리의 구멍이 화면 밖으로 밀린다. */
  onFit: () => void;
}

const BTN =
  "flex h-7 w-7 items-center justify-center text-fg-muted transition-colors hover:bg-accent-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep";

export function MapZoomControls({ onZoomIn, onZoomOut, onFit }: MapZoomControlsProps) {
  return (
    <div className="absolute bottom-3 right-3 z-10 flex flex-col overflow-hidden rounded-lg border border-accent-border/50 bg-bg-elevated shadow-sm">
      <button type="button" onClick={onZoomIn} aria-label="지도 확대" className={BTN}>
        <Plus size={14} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onZoomOut}
        aria-label="지도 축소"
        className={`${BTN} border-y border-accent-border/40`}
      >
        <Minus size={14} aria-hidden />
      </button>
      <button type="button" onClick={onFit} aria-label="지도 전체 보기" className={BTN}>
        <Maximize2 size={13} aria-hidden />
      </button>
    </div>
  );
}
