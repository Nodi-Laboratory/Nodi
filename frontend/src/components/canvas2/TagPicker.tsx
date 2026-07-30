"use client";

/**
 * 태그 드롭다운 — 기존 태그 선택 + 새 태그 추가.
 *
 * 태그를 바꾸면 아이템이 그 태그의 열로 가야 하지만 **자동으로 옮기지 않는다.**
 * 대신 "위치 정리" 버튼이 뜬다(사용자 지시). 학생이 방금 보고 있던 자리에서
 * 글이 갑자기 사라지면 흐름이 끊긴다.
 */

import { Check, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
  current: string | null;
  /** 이 세션에 이미 있는 태그들(첫 등장 순서). */
  options: readonly string[];
  onPick: (tag: string | null) => void;
  onClose: () => void;
}

/** 태그 길이 상한. 열 라벨이 아이템 폭을 넘으면 화면이 무너진다. */
const MAX_TAG = 16;

export function TagPicker({ current, options, onPick, onClose }: Props) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const submit = () => {
    const t = draft.trim().slice(0, MAX_TAG);
    if (!t) return;
    onPick(t);
  };

  return (
    <div
      ref={rootRef}
      data-no-pan
      className="ui absolute right-0 top-8 z-20 w-52 overflow-hidden rounded-lg border py-1"
      style={{
        background: "var(--c-raised)",
        borderColor: "var(--c-rule)",
        boxShadow: "var(--c-shadow-lg)",
      }}
      // role="listbox" 안에 <button role="option">은 유효하지 않은 조합이다.
      // 실제 동작(클릭·Tab·Enter)이 브라우저 기본으로 이미 되므로, 거짓
      // 시맨틱을 붙이는 것보다 메뉴로 정직하게 표시하는 편이 낫다.
      role="menu"
      aria-label="분류 선택"
    >
      <div className="label px-3 pb-1 pt-1.5" style={{ color: "var(--c-ink-faint)" }}>
        분류
      </div>

      <button
        type="button"
        role="menuitemradio"
        aria-checked={current === null}
        onClick={() => onPick(null)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--c-sunk)]"
        style={{ color: "var(--c-ink-soft)" }}
      >
        분류 없음
        {current === null && <Check size={14} style={{ color: "var(--c-live)" }} />}
      </button>

      <div className="max-h-52 overflow-auto">
        {options.map((t) => (
          <button
            key={t}
            type="button"
            role="menuitemradio"
            aria-checked={t === current}
            onClick={() => onPick(t)}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--c-sunk)]"
            style={{ color: "var(--c-ink)" }}
          >
            <span className="truncate">{t}</span>
            {t === current && <Check size={14} style={{ color: "var(--c-live)" }} />}
          </button>
        ))}
      </div>

      <div className="mx-2 my-1 h-px" style={{ background: "var(--c-rule)" }} />

      {adding ? (
        <div className="flex items-center gap-1 px-2 pb-1.5">
          <input
            ref={inputRef}
            value={draft}
            maxLength={MAX_TAG}
            placeholder="새 분류 이름"
            onChange={(e) => setDraft(e.target.value)}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onKeyDown={(e) => {
              e.stopPropagation();
              // 한글 조합 중 Enter는 IME의 확정이다 — 가로채면 마지막 글자가 잘린다.
              if (composing.current) return;
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setAdding(false);
            }}
            className="min-w-0 flex-1 rounded border px-2 py-1 text-sm outline-none"
            style={{ borderColor: "var(--c-rule)", background: "var(--c-paper)" }}
          />
          <button
            type="button"
            onClick={submit}
            aria-label="분류 추가"
            className="rounded p-1 transition-colors hover:bg-[var(--c-sunk)]"
            style={{ color: "var(--c-live)" }}
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={() => setAdding(false)}
            aria-label="취소"
            className="rounded p-1 transition-colors hover:bg-[var(--c-sunk)]"
            style={{ color: "var(--c-ink-faint)" }}
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--c-sunk)]"
          style={{ color: "var(--c-ink-soft)" }}
        >
          <Plus size={14} />새 분류 추가
        </button>
      )}
    </div>
  );
}
