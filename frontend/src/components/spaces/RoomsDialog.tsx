"use client";

/**
 * 공간 카드를 누르면 뜨는 **대화방 팝업** (사용자 지시 2026-08-09).
 *
 * 예전에는 카드를 누르면 곧장 그 공간의 **가장 최근 방**으로 들어갔다. 그런데
 * 학생이 하려는 일은 대개 "어제 하던 그 대화"를 잇는 것이고, 그 방이 최근
 * 방이라는 보장은 없다 — 들어가서 다시 지난 대화 서랍을 여는 걸음이 늘 붙었다.
 * 팝업이 그 걸음을 앞으로 당긴다.
 *
 * 여기서 **이름 변경·삭제**도 한다. 방 관리는 원래 캔버스 안(지난 대화 서랍)
 * 에서만 됐는데, 방을 고르는 자리에서 정리도 되는 편이 자연스럽다.
 */

import { useEffect } from "react";
import { X } from "lucide-react";
import type { RoomRow } from "@/lib/api/rooms";
import { RoomList } from "./RoomList";

export function RoomsDialog({
  title,
  rooms,
  loading,
  onOpen,
  onRename,
  onDelete,
  onClose,
}: {
  title: string;
  rooms: readonly RoomRow[];
  loading: boolean;
  onOpen: (room: RoomRow) => void;
  onRename: (room: RoomRow, title: string) => void;
  onDelete: (room: RoomRow) => void;
  onClose: () => void;
}) {
  // Esc로 닫는다 — 팝업에 갇히면 바깥을 누를 곳을 찾아다니게 된다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      // 어두운 판을 누르면 닫힌다. 상자 안쪽 클릭은 여기까지 안 올라온다.
      onClick={onClose}
      style={{ background: "rgba(30, 32, 26, 0.34)" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 대화방 목록`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[76vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-accent-border bg-bg-elevated shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-accent-border/50 px-6 py-4">
          <div>
            <h2 className="text-[19px] font-bold text-fg">{title}</h2>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              이어서 이야기할 대화방을 고르세요.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-9 w-9 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-accent-soft"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-fg-muted">
              불러오는 중이에요…
            </p>
          ) : (
            <RoomList
              rooms={rooms}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
              empty="아직 이 공간에는 대화가 없어요."
            />
          )}
        </div>
      </div>
    </div>
  );
}
