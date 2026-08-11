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
import { Plus, X } from "lucide-react";
import type { RoomRow } from "@/lib/api/rooms";
import { RoomList } from "./RoomList";

export function RoomsDialog({
  title,
  rooms,
  loading,
  onOpen,
  onRename,
  onDelete,
  message,
  onNewRoom,
  creating = false,
  onClose,
}: {
  title: string;
  rooms: readonly RoomRow[];
  loading: boolean;
  onOpen: (room: RoomRow) => void;
  onRename: (room: RoomRow, title: string) => void;
  onDelete: (room: RoomRow) => void;
  /** 실패했을 때 학생에게 할 말. 없으면 아무것도 안 그린다. */
  message?: string | null;
  /** 이 공간에 방을 새로 만든다. 만들고 나면 호출부가 그 방으로 보낸다. */
  onNewRoom: () => void;
  creating?: boolean;
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
        /* 연두 테두리를 걷어내고 그림자로만 띄운다(사용자 지시 2026-08-11). */
        className="flex max-h-[76vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-bg-elevated"
        style={{ boxShadow: "0 18px 50px rgba(23,23,18,.14), 0 2px 8px rgba(23,23,18,.06)" }}
      >
        <header className="flex shrink-0 items-center justify-between px-7 pb-4 pt-6">
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

        {message && (
          <p className="shrink-0 px-7 py-2 text-[13px] text-danger">{message}</p>
        )}

        {/**
         * **이 학급에 새 대화방 만들기** (사용자 지시 2026-08-11, 참조 이미지 1).
         *
         * 예전에는 방을 새로 만들려면 팝업을 닫고 그 공간에 들어간 뒤 캔버스
         * 상단의 서랍을 열어야 했다 — 세 걸음이다. 방을 고르러 온 자리에서
         * "새로 시작하기"도 할 수 있는 편이 맞다.
         */}
        <div className="shrink-0 px-7 pb-4">
          <button
            type="button"
            onClick={onNewRoom}
            disabled={creating}
            data-new-room
            className="flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-[15px] font-semibold transition-opacity disabled:opacity-50"
            style={{ background: "var(--accent-soft)", color: "var(--accent-deep)" }}
          >
            <Plus size={17} aria-hidden />
            {creating ? "만드는 중…" : "새 대화 시작하기"}
          </button>
        </div>

        {/* 구분선은 **양 끝이 변에 안 닿는다** — 상자를 두 칸으로 자르지 않는다. */}
        <div className="mx-7 h-px shrink-0" style={{ background: "var(--line)" }} />

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
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
