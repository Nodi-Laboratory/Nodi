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

/** 메뉴 한 줄의 높이(px, `py-1.5` + `text-sm`). 자리 계산의 눈금이다. */
const ROW_H = 30;
/** `⋯` 메뉴의 높이 — 수정·분류 변경·구분선·삭제. */
const MENU_H = ROW_H * 3 + 17;
/** 분류 목록의 높이 — 분류 수만큼 + [새 분류 추가]. 목록은 스스로 구른다. */
function pickerHeight(options: readonly string[]): number {
  return ROW_H * (Math.min(options.length, 7) + 1) + 17;
}

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
  resized,
  onResetSize,
  onOpenChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  /**
   * 아래로 펼칠 자리가 없으면 **위로** 펼친다.
   *
   * 하단 입력창은 무대에서 `z-50`이고 아이템 오버레이는 `z-3`이라(D120),
   * 메뉴의 z-index를 아무리 올려도 **입력창을 이길 수 없다** — 겹치면 메뉴가
   * 통째로 그 아래로 들어간다. 실측 2026-08-09(720px 화면): 아래쪽 카드의
   * 메뉴가 [삭제] 한 줄만 남기고 입력창에 먹혀 눌리지 않았다.
   *
   * 캔버스 상단 바(D217)가 세로를 62px 먹으면서 자주 드러났을 뿐, 원래 있던
   * 결함이다 — 카드는 입력창 위 어디에나 놓일 수 있다.
   */
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * 이 높이가 아래에 들어가나. 바닥은 화면이 아니라 **입력창 윗변**이다 —
   * 입력창에 닿는 순간 가려지므로 화면 안이라는 사실은 뜻이 없다.
   */
  const fitsBelow = useCallback((need: number) => {
    const anchor = rootRef.current?.getBoundingClientRect();
    if (!anchor) return true;
    const floor =
      document.querySelector("[data-ask-bar]")?.getBoundingClientRect().top ??
      window.innerHeight;
    return floor - anchor.bottom >= need;
  }, []);

  const expanded = open || tagOpen;
  useEffect(() => {
    onOpenChange?.(expanded);
  }, [expanded, onOpenChange]);
  // 사라질 때도 알려 준다 — 안 그러면 상위가 "열려 있다"고 믿은 채 남는다.
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);

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
          /**
           * 방향은 **여는 순간** 정한다. 그려 놓고 재서 뒤집으면 한 프레임
           * 동안 엉뚱한 자리에 떴다가 튄다. 필요한 높이는 목록에서 곧장
           * 나오므로(줄 수 × 줄 높이) 재지 않아도 된다.
           */
          setDropUp(!fitsBelow(MENU_H + (resized && onResetSize ? ROW_H : 0)));
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
          className={`ui absolute right-0 w-36 overflow-hidden rounded-lg border py-1 ${
            dropUp ? "bottom-8" : "top-8"
          }`}
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
            onClick={() => {
              // 분류 목록은 이 메뉴보다 길다 — 같은 자리에서 다시 잰다.
              setDropUp(!fitsBelow(pickerHeight(tagOptions)));
              setTagOpen(true);
            }}
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
          dropUp={dropUp}
          onPick={(t) => {
            setTagOpen(false);
            setOpen(false);
            onTagChange(t);
          }}
          onRenameTag={onRenameTag}
          onRemoveTag={onRemoveTag}
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
