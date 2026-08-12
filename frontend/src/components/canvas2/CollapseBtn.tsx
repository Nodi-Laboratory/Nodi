"use client";

/**
 * 딸린 상자(도판·클립)를 **접는 ×** (사용자 지시 2026-08-12).
 *
 * 평소에는 안 보이고 상자에 마우스를 얹으면 오른쪽 위에 뜬다 — 늘 떠 있으면
 * 그림 위에 단추가 하나 얹혀 있는 셈이라 정작 그림이 안 읽힌다.
 *
 * ⚠️ **손가락에는 hover가 없다**(globals.css의 그 규칙과 같은 문제). 그래서
 * coarse 포인터에서는 늘 보이게 둔다 — 안 그러면 패드에서 접을 방법이 없다.
 */

import { X } from "lucide-react";
import { foldAway } from "@/lib/canvas2/foldAway";

export function CollapseBtn({ onCollapse }: { onCollapse: () => void }) {
  return (
    <button
      type="button"
      data-no-pan
      aria-label="접어서 카드 안에 넣기"
      title="접어서 카드 안에 넣기"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        // 접히는 연출은 한 곳에서 정한다(`lib/canvas2/foldAway.ts`) — 클립의
        // ×도 같은 함수를 쓰므로 둘의 움직임이 갈리지 않는다.
        foldAway(
          (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-canvas-item]"),
          onCollapse,
        );
      }}
      className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
      style={{
        background: "var(--c-raised)",
        color: "var(--c-ink-soft)",
        boxShadow: "0 1px 4px rgba(0,0,0,.18)",
      }}
    >
      <X size={14} />
    </button>
  );
}
