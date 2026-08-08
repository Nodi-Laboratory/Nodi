"use client";

/**
 * 아이템 `⋯` 메뉴 — 삭제 · 수정 · 분류 변경.
 *
 * 아이템의 **우상단**에 뜬다(사용자 지시). 평소에는 아무것도 안 보이고,
 * 마우스를 올리거나 클릭했을 때만 나타난다 — 캔버스에 버튼이 널려 있으면
 * 글이 안 읽힌다.
 *
 * 열림 상태를 상위(`TextItem`)에도 알린다. hover만으로 뜨게 되면서, 메뉴를
 * 펼쳐 둔 채 마우스가 글 밖으로 나가면 **메뉴가 통째로 사라지는** 상황이
 * 생기기 때문이다. 상위가 그동안은 계속 그려 준다.
 */

import { Maximize2, MoreHorizontal, Pencil, Tag, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TagPicker } from "./TagPicker";

interface Props {
  tag: string | null;
  tagOptions: readonly string[];
  onEdit: () => void;
  onDelete: () => void;
  onTagChange: (tag: string | null) => void;
  /** 태그 이름 변경 — 그 태그를 단 **모든 카드**에 반영된다 (D147). */
  onRenameTag: (from: string, to: string) => void;
  /** 태그 삭제 — 그 태그를 단 모든 카드가 분류 없음이 된다 (D147). */
  onRemoveTag: (tag: string) => void;
  /** 새 분류를 만들 수 있나 — 이어진 카드가 2장 이상일 때만 (D210 6-2). */
  canCreateTag: boolean;
  /** 손잡이로 크기를 바꾼 상태인가 — 그때만 되돌리기를 보여 준다 (D142). */
  resized?: boolean;
  onResetSize?: () => void;
  /** 메뉴(또는 분류 목록)가 펼쳐져 있나. */
  onOpenChange?: (open: boolean) => void;
}

export function ItemMenu({
  tag,
  tagOptions,
  onEdit,
  onDelete,
  onTagChange,
  onRenameTag,
  onRemoveTag,
  canCreateTag,
  resized,
  onResetSize,
  onOpenChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);

  const expanded = open || tagOpen;
  useEffect(() => {
    onOpenChange?.(expanded);
  }, [expanded, onOpenChange]);
  // 사라질 때도 알려 준다 — 안 그러면 상위가 "열려 있다"고 믿은 채 남는다.
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * 화살표로 항목을 옮긴다.
   *
   * `role="menu"`를 붙여 놓고 키보드 이동을 안 주면 스크린리더가 "메뉴"라고
   * 알려 준 뒤 학생이 그 안에서 움직일 방법이 없다 — 이름만 메뉴다.
   */
  const moveFocus = useCallback((dir: 1 | -1) => {
    const el = menuRef.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? 0 : (at + dir + items.length) % items.length;
    items[next]?.focus();
  }, []);

  // 열리면 첫 항목에 포커스를 준다. 안 주면 Tab이 메뉴 밖으로 나간다.
  useEffect(() => {
    if (!open || tagOpen) return;
    const raf = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, tagOpen]);

  useEffect(() => {
    if (!open || tagOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowDown") {
        e.preventDefault();
        moveFocus(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveFocus(-1);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, tagOpen, moveFocus]);

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
          ref={menuRef}
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
          {resized && onResetSize && (
            <MenuItem
              icon={<Maximize2 size={14} />}
              label="크기 되돌리기"
              onClick={() => {
                setOpen(false);
                onResetSize();
              }}
            />
          )}
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
          onRenameTag={onRenameTag}
          onRemoveTag={onRemoveTag}
          canCreateTag={canCreateTag}
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
