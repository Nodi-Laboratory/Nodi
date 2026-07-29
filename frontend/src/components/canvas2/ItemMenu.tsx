"use client";

/**
 * 아이템 `⋯` 메뉴 — 삭제 · 수정 · 분류 변경.
 *
 * 선택된 아이템의 **우상단**에 뜬다(사용자 지시). 평소에는 아무것도 안 보이고,
 * 아이템을 클릭했을 때만 나타난다 — 캔버스에 버튼이 널려 있으면 글이 안 읽힌다.
 */

import { MoreHorizontal, Pencil, Tag, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TagPicker } from "./TagPicker";

interface Props {
  tag: string | null;
  tagOptions: readonly string[];
  onEdit: () => void;
  onDelete: () => void;
  onTagChange: (tag: string | null) => void;
}

export function ItemMenu({ tag, tagOptions, onEdit, onDelete, onTagChange }: Props) {
  const [open, setOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || tagOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, tagOpen]);

  return (
    <div ref={rootRef} data-no-pan className="absolute -top-1 right-0 z-20">
      <button
        type="button"
        aria-label="이 글의 메뉴"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()} // 드래그로 넘어가지 않게
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
          setTagOpen(false);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-md border transition-colors"
        style={{
          background: "var(--c-raised)",
          borderColor: "var(--c-rule)",
          color: open ? "var(--c-ink)" : "var(--c-ink-soft)",
          boxShadow: "var(--c-shadow-sm)",
        }}
      >
        <MoreHorizontal size={15} />
      </button>

      {open && !tagOpen && (
        <div
          className="ui absolute right-0 top-8 w-36 overflow-hidden rounded-lg border py-1"
          style={{
            background: "var(--c-raised)",
            borderColor: "var(--c-rule)",
            boxShadow: "var(--c-shadow-lg)",
          }}
          role="menu"
        >
          <MenuItem
            icon={<Pencil size={14} />}
            label="수정"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          />
          <MenuItem
            icon={<Tag size={14} />}
            label="분류 변경"
            onClick={() => setTagOpen(true)}
          />
          <div className="mx-2 my-1 h-px" style={{ background: "var(--c-rule)" }} />
          <MenuItem
            icon={<Trash2 size={14} />}
            label="삭제"
            danger
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          />
        </div>
      )}

      {tagOpen && (
        <TagPicker
          current={tag}
          options={tagOptions}
          onPick={(t) => {
            setTagOpen(false);
            setOpen(false);
            onTagChange(t);
          }}
          onClose={() => {
            setTagOpen(false);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--c-sunk)]"
      style={{ color: danger ? "var(--c-danger)" : "var(--c-ink)" }}
    >
      {icon}
      {label}
    </button>
  );
}
