"use client";

/**
 * 지도 확대 손잡이 (D191).
 *
 * 휠만으로도 되지만 **버튼이 있어야 하는 이유는 따로 있다** — 지금까지는 지도를
 * 확대하는 곳이 어디인지 화면에 아무 표시도 없어서, 학생이 브라우저를 확대해
 * 놓고 되돌리려다 지도를 줄였다(사용자 보고 2026-08-06). 버튼은 "여기가 지도의
 * 배율"이라고 말한다. 휠 없는 환경에서도 되는 것은 덤이다.
 */

import { Minus, Plus } from "lucide-react";

export interface MapZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
}

/**
 * ⚠️ **전체 보기(⤢)는 없다** (사용자 지시 2026-08-09).
 *
 * 지도가 홈의 **배경**이 되면서 "전부 담아 보기"의 값이 사라졌다 — 처음
 * 그려질 때 이미 전부 담아 맞추고, 그 위에는 인사말과 입력창이 있다. 배경을
 * 다시 맞추자고 누를 일이 없다.
 */

const BTN =
  "flex h-7 w-7 items-center justify-center text-fg-muted transition-colors hover:bg-accent-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep";

export function MapZoomControls({ onZoomIn, onZoomOut }: MapZoomControlsProps) {
  return (
    <div className="absolute bottom-3 right-3 z-10 flex flex-col overflow-hidden rounded-lg border border-accent-border/50 bg-bg-elevated shadow-sm">
      <button type="button" onClick={onZoomIn} aria-label="지도 확대" className={BTN}>
        <Plus size={14} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onZoomOut}
        aria-label="지도 축소"
        className={`${BTN} border-t border-accent-border/40`}
      >
        <Minus size={14} aria-hidden />
      </button>
    </div>
  );
}
