"use client";

// Slide-over that surfaces Nodi's persistent multi-session list (which the figma
// single-screen prototype lacked). Opened by the TopBar hamburger. Reuses the
// existing SessionList wholesale (new/rename/delete/select + optimistic rows).

import { useEffect } from "react";
import { X } from "lucide-react";
import type { SpaceTarget } from "@/lib/api";
import { SessionList } from "@/components/workspace/SessionList";

export default function SessionDrawer({
  open,
  onClose,
  target,
}: {
  open: boolean;
  onClose: () => void;
  target: SpaceTarget;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
        aria-hidden
      />
      <div className="absolute left-0 top-0 flex h-full w-72 flex-col border-r border-accent-border/40 bg-bg-elevated shadow-xl">
        <div className="flex items-center justify-between border-b border-accent-border/30 px-4 py-3">
          <span className="text-sm font-semibold text-fg">대화 목록</span>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-muted hover:text-fg"
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>
        {/* 대화를 고르면 스스로 닫는다 (D173). 안 닫으면 목록이 캔버스를
            덮은 채로 남고, 그 반투명 오버레이가 캔버스 클릭을 통째로 먹는다. */}
        <SessionList target={target} onPicked={onClose} />
      </div>
    </div>
  );
}
