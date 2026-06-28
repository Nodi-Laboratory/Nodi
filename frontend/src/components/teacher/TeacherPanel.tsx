"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { School, Users, FolderOpen, Plus, Copy, Check, X } from "lucide-react";
import { createClass } from "@/lib/api";
import { useTeacherClasses } from "@/lib/queries";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { StudentsTab } from "./StudentsTab";
import { MaterialsTab } from "./MaterialsTab";

/**
 * 교사 컨트롤 패널 — 대화 공간 없이 컨트롤만(D7/D19).
 * 학급 선택 + [학생 대화 열람] / [자료실] 탭. D33: 학급 생성 모달 + 코드 공유.
 */
type Tab = "students" | "materials";

export function TeacherPanel() {
  const { data: classes, isLoading } = useTeacherClasses();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("students");
  const [createOpen, setCreateOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // 선택값 우선, 없으면 첫 학급(파생값 — effect setState 회피)
  const classId = picked ?? classes?.[0]?.id ?? null;
  const setClassId = setPicked;
  const current = classes?.find((c) => c.id === classId) ?? null;

  const handleCreated = (newClassId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["teacher", "classes"] });
    setPicked(newClassId); // 새 학급 자동 선택
    setCreateOpen(false);
  };

  const copyCode = async () => {
    if (!current?.join_code) return;
    try {
      await navigator.clipboard.writeText(current.join_code);
      setCopied(true);
    } catch {
      /* 클립보드 권한 없음 — 무시 */
    }
  };
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <header className="flex flex-wrap items-center gap-3 border-b border-accent-border/30 bg-bg-elevated px-6 py-3">
        <div className="flex items-center gap-2">
          <School size={18} className="text-accent-deep" />
          <h1 className="text-base font-bold">교사 콘솔</h1>
        </div>

        {/* 학급 선택 */}
        {isLoading ? (
          <span className="text-sm text-fg-muted">학급 불러오는 중…</span>
        ) : !classes || classes.length === 0 ? (
          <span className="text-sm text-fg-muted">담당 학급이 없습니다.</span>
        ) : (
          <select
            value={classId ?? ""}
            onChange={(e) => setClassId(e.target.value)}
            className="rounded-lg border border-accent-border/50 bg-bg px-3 py-1.5 text-sm text-fg"
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? "학급"} · 학생 {c.student_count}명
              </option>
            ))}
          </select>
        )}

        {/* 새 학급 만들기 — 빈 상태에서도 노출(막다른 길 제거) */}
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1 rounded-lg border border-accent-deep/60 bg-accent/30 px-2.5 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/50"
        >
          <Plus size={15} /> 새 학급
        </button>

        {current?.join_code && (
          <span className="flex items-center gap-1 rounded-md bg-accent/30 px-2 py-1 text-xs font-medium text-accent-fg">
            코드 {current.join_code}
            <button
              type="button"
              onClick={copyCode}
              title="학생에게 공유할 합류 코드 복사"
              className="ml-0.5 rounded p-0.5 text-accent-fg/80 transition-colors hover:text-accent-fg"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </span>
        )}

        <div className="ml-auto">
          <AccountMenu />
        </div>
      </header>

      {classId ? (
        <>
          <nav className="flex gap-1 border-b border-accent-border/30 bg-bg-elevated px-4">
            <TabButton
              active={tab === "students"}
              onClick={() => setTab("students")}
              icon={<Users size={15} />}
              label="학생 대화"
            />
            <TabButton
              active={tab === "materials"}
              onClick={() => setTab("materials")}
              icon={<FolderOpen size={15} />}
              label="자료실"
            />
          </nav>

          <main className="min-h-0 flex-1 overflow-hidden">
            {tab === "students" ? (
              <StudentsTab key={classId} classId={classId} />
            ) : (
              <div className="h-full overflow-auto">
                <MaterialsTab key={classId} classId={classId} />
              </div>
            )}
          </main>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-fg-muted">
          {isLoading ? null : (
            <>
              <p>아직 담당 학급이 없습니다.</p>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="flex items-center gap-1 rounded-lg bg-accent-deep px-3 py-1.5 text-sm font-medium text-white transition-colors hover:brightness-95"
              >
                <Plus size={15} /> 첫 학급 만들기
              </button>
            </>
          )}
        </div>
      )}

      {createOpen && (
        <CreateClassModal
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

/** D33: 학급 이름 입력 모달 → createClass → 성공 콜백(목록 갱신·자동 선택). */
function CreateClassModal({
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

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors ${
        active
          ? "border-accent-deep text-fg"
          : "border-transparent text-fg-muted hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
