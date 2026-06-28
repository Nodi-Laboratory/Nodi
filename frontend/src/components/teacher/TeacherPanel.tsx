"use client";

import { useState } from "react";
import { School, Users, FolderOpen } from "lucide-react";
import { useTeacherClasses } from "@/lib/queries";
import { StudentsTab } from "./StudentsTab";
import { MaterialsTab } from "./MaterialsTab";

/**
 * 교사 컨트롤 패널 — 대화 공간 없이 컨트롤만(D7/D19).
 * 학급 선택 + [학생 대화 열람] / [자료실] 탭.
 */
type Tab = "students" | "materials";

export function TeacherPanel() {
  const { data: classes, isLoading } = useTeacherClasses();
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("students");

  // 선택값 우선, 없으면 첫 학급(파생값 — effect setState 회피)
  const classId = picked ?? classes?.[0]?.id ?? null;
  const setClassId = setPicked;
  const current = classes?.find((c) => c.id === classId) ?? null;

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

        {current?.join_code && (
          <span className="rounded-md bg-accent/30 px-2 py-1 text-xs font-medium text-accent-fg">
            코드 {current.join_code}
          </span>
        )}
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
        <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
          {isLoading ? "" : "학급을 선택하세요."}
        </div>
      )}
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
