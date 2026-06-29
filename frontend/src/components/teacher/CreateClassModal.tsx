"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { createClass } from "@/lib/api";

/**
 * D33: 학급 이름 입력 모달 → createClass → 성공 콜백(생성된 학급 id 전달).
 * 교사 홈(TeacherHome)·상세에서 공용으로 재사용.
 */
export function CreateClassModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (classId: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("학급 이름을 입력하세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createClass(trimmed);
      onCreated(created.id);
    } catch {
      setError("학급 생성에 실패했습니다. 잠시 후 다시 시도하세요.");
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="새 학급 만들기"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-accent-border/40 bg-bg-elevated p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-fg">새 학급 만들기</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-fg-muted transition-colors hover:text-fg"
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>
        <label className="mb-1 block text-xs font-medium text-fg-muted">
          학급 이름
        </label>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) {
              e.preventDefault();
              void submit();
            }
          }}
          maxLength={120}
          placeholder="예: 3학년 2반 과학"
          disabled={busy}
          className="w-full rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent-deep disabled:opacity-60"
        />
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-accent-border/50 px-3 py-1.5 text-sm text-fg-muted transition-colors hover:text-fg disabled:opacity-60"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
            className="rounded-lg bg-accent-deep px-3 py-1.5 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60"
          >
            {busy ? "만드는 중…" : "만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}
