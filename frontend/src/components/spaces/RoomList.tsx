"use client";

/**
 * 대화방 목록 한 벌 (사용자 지시 2026-08-09).
 *
 * 두 곳이 **같은 부품**을 쓴다 — 공간 카드를 누르면 뜨는 팝업, 그리고 화면
 * 아래의 "최근 대화" 상자. 줄 생김새가 갈리면 같은 것을 두 번 배워야 한다.
 *
 * 다른 것은 하나다: **⋮는 팝업에만 있다**(사용자 지시). 최근 목록은 여러
 * 공간의 방이 섞여 있어, 거기서 지우면 "어디 것을 지웠는지" 되짚을 자리가
 * 없다. 그쪽은 **가는 길**이지 관리하는 자리가 아니다.
 */

import { useEffect, useRef, useState } from "react";
import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import type { RoomRow } from "@/lib/api/rooms";
import { ConceptChips } from "./ConceptChips";

/** 제목이 없는 방의 표시 이름 — `SessionList`와 같은 말을 쓴다(D173). */
export const UNTITLED = "제목 없는 대화";

/** 한 줄에 붙이는 개념 수 상한. 넘치면 `…`. */
const CHIP_CAP = 3;

function RoomRowView({
  room,
  onOpen,
  onRename,
  onDelete,
  showSpace,
}: {
  room: RoomRow;
  onOpen: (room: RoomRow) => void;
  /** 없으면 ⋮ 자체가 안 뜬다. */
  onRename?: (room: RoomRow, title: string) => void;
  onDelete?: (room: RoomRow) => void;
  showSpace?: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * ⋮는 **내 방에만** 붙는다. 선생님 화면에는 학생 방도 뜨는데, 이름 변경·
   * 삭제는 주인만 되므로(RLS) 그 단추를 주면 눌러도 아무 일이 안 일어난다.
   */
  const hasMenu = Boolean(onRename || onDelete) && room.is_mine;

  // 바깥을 누르면 닫는다. 안 그러면 메뉴가 여러 줄에서 동시에 열린 채 남는다.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  const title = room.title.trim() || UNTITLED;

  return (
    <div
      ref={rootRef}
      data-room-row={room.id}
      className="relative flex items-center gap-2 rounded-xl px-3 py-2.5 transition-colors hover:bg-accent-soft/40"
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          maxLength={200}
          aria-label="대화방 이름"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setEditing(false);
              if (draft.trim()) onRename?.(room, draft.trim());
            }
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => setEditing(false)}
          className="min-w-0 flex-1 rounded-lg border border-accent-border bg-bg-elevated px-2 py-1 text-[15px] text-fg outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => onOpen(room)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="max-w-[45%] shrink-0 truncate text-[15px] text-fg">{title}</span>
          {/* 어느 공간의 방인지 — 최근 목록에서만. 여러 공간이 섞여 있다. */}
          {showSpace && room.space_name && (
            <span className="shrink-0 truncate text-[12px] text-fg-muted">
              {room.space_name}
            </span>
          )}
          <ConceptChips concepts={room.concepts} cap={CHIP_CAP} />
        </button>
      )}

      {hasMenu && !editing && (
        <>
          <button
            type="button"
            aria-label={`${title} 메뉴`}
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-accent-soft"
          >
            <MoreVertical size={16} />
          </button>
          {menu && (
            <div
              role="menu"
              className="absolute right-2 top-9 z-10 w-32 overflow-hidden rounded-lg border border-accent-border bg-bg-elevated py-1 shadow-lg"
            >
              {onRename && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    setDraft(room.title);
                    setEditing(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg transition-colors hover:bg-accent-soft/60"
                >
                  <Pencil size={14} />
                  이름 변경
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onDelete(room);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-danger transition-colors hover:bg-accent-soft/60"
                >
                  <Trash2 size={14} />
                  삭제
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function RoomList({
  rooms,
  onOpen,
  onRename,
  onDelete,
  showSpace,
  empty = "아직 대화가 없어요.",
}: {
  rooms: readonly RoomRow[];
  onOpen: (room: RoomRow) => void;
  onRename?: (room: RoomRow, title: string) => void;
  onDelete?: (room: RoomRow) => void;
  showSpace?: boolean;
  empty?: string;
}) {
  if (rooms.length === 0) {
    return <p className="px-3 py-6 text-center text-sm text-fg-muted">{empty}</p>;
  }
  return (
    <div className="flex flex-col">
      {rooms.map((r) => (
        <RoomRowView
          key={r.id}
          room={r}
          onOpen={onOpen}
          onRename={onRename}
          onDelete={onDelete}
          showSpace={showSpace}
        />
      ))}
    </div>
  );
}
