"use client";

import { useState } from "react";
import { ChevronRight, Users, FolderOpen, Copy, Check } from "lucide-react";
import { useTeacherOverview } from "@/lib/queries";
import { TeacherHeader } from "./TeacherHeader";
import { StudentsTab } from "./StudentsTab";
import { MaterialsTab } from "./MaterialsTab";

/**
 * D67: 학급 상세 — 현 TeacherPanel 본문(학생 대화 열람 / 자료실 탭) 이전.
 * 헤더는 공용 TeacherHeader(좌상단 "교사 콘솔"=홈 링크) + 빵부스러기(학급명).
 */
type Tab = "students" | "materials";

export function ClassDetail({ classId }: { classId: string }) {
  const { data: classes } = useTeacherOverview();
  const [tab, setTab] = useState<Tab>("students");
  const [copied, setCopied] = useState(false);

  const current = classes?.find((c) => c.id === classId) ?? null;

  const copyCode = async () => {
    if (!current?.join_code) return;
    try {
      await navigator.clipboard.writeText(current.join_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* 클립보드 권한 없음 — 무시 */
    }
  };

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <TeacherHeader>
        <nav
          aria-label="위치"
          className="flex items-center gap-1 text-sm text-fg-muted"
        >
          <ChevronRight size={14} className="opacity-60" />
          <span className="font-medium text-fg">{current?.name ?? "학급"}</span>
        </nav>

        {current?.join_code && (
          <span className="flex items-center gap-1 rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-accent-fg">
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
      </TeacherHeader>

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
