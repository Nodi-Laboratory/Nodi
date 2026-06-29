"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Users, FolderOpen, Plus, Copy, Check, Clock } from "lucide-react";
import { useTeacherOverview } from "@/lib/queries";
import type { TeacherClassOverview } from "@/lib/types";
import { TeacherHeader } from "./TeacherHeader";
import { CreateClassModal } from "./CreateClassModal";

/**
 * D67: 교사 콘솔 홈 — 담당 학급을 카드 그리드로 한눈에.
 * 각 카드: 학급명 · 합류코드(복사) · 학생 수 · 자료 수 · 최근 활동(상대시간).
 * [+ 새 학급] 카드(빈 상태에서도). 카드 클릭 → /teacher/{id} 상세.
 */
export function TeacherHome() {
  const { data: classes, isLoading } = useTeacherOverview();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  const handleCreated = (newClassId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["teacher", "overview"] });
    void queryClient.invalidateQueries({ queryKey: ["teacher", "classes"] });
    setCreateOpen(false);
    router.push(`/teacher/${newClassId}`); // 생성 직후 상세로 이동
  };

  const list = classes ?? [];

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <TeacherHeader />

      <main className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-lg font-bold text-fg">내 학급</h2>
            {list.length > 0 ? (
              <span className="text-sm text-fg-muted">{list.length}개 학급</span>
            ) : null}
          </div>

          {isLoading ? (
            <p className="text-sm text-fg-muted">학급 불러오는 중…</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((c) => (
                <ClassCard
                  key={c.id}
                  cls={c}
                  onOpen={() => router.push(`/teacher/${c.id}`)}
                />
              ))}
              <NewClassCard
                empty={list.length === 0}
                onClick={() => setCreateOpen(true)}
              />
            </div>
          )}
        </div>
      </main>

      {createOpen && (
        <CreateClassModal
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

function ClassCard({
  cls,
  onOpen,
}: {
  cls: TeacherClassOverview;
  onOpen: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyCode = async (e: React.MouseEvent) => {
    e.stopPropagation(); // 카드 클릭(상세 이동)과 분리
    if (!cls.join_code) return;
    try {
      await navigator.clipboard.writeText(cls.join_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* 클립보드 권한 없음 — 무시 */
    }
  };

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-3 rounded-2xl border border-accent-border/30 bg-bg-elevated p-4 text-left transition-colors hover:border-accent-deep/60 hover:bg-accent/10"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-base font-bold text-fg" title={cls.name ?? "학급"}>
          {cls.name ?? "학급"}
        </h3>
      </div>

      {cls.join_code ? (
        <span className="flex w-fit items-center gap-1 rounded-md bg-accent/30 px-2 py-1 text-xs font-medium text-accent-fg">
          코드 {cls.join_code}
          <span
            role="button"
            tabIndex={0}
            onClick={copyCode}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void copyCode(e as unknown as React.MouseEvent);
              }
            }}
            title="학생에게 공유할 합류 코드 복사"
            className="ml-0.5 cursor-pointer rounded p-0.5 text-accent-fg/80 transition-colors hover:text-accent-fg"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </span>
        </span>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
        <span className="flex items-center gap-1">
          <Users size={14} className="opacity-70" />
          학생 {cls.student_count}명
        </span>
        <span className="flex items-center gap-1">
          <FolderOpen size={14} className="opacity-70" />
          자료 {cls.material_count}개
        </span>
      </div>
      <span className="flex items-center gap-1 text-xs text-fg-muted">
        <Clock size={12} className="opacity-70" />
        {formatRelative(cls.last_activity_at)}
      </span>
    </button>
  );
}

function NewClassCard({
  empty,
  onClick,
}: {
  empty: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-accent-border/50 p-4 text-fg-muted transition-colors hover:border-accent-deep hover:text-accent-deep"
    >
      <Plus size={22} />
      <span className="text-sm font-medium">
        {empty ? "첫 학급 만들기" : "새 학급"}
      </span>
      {empty ? (
        <span className="text-xs text-fg-muted">
          학급을 만들고 합류 코드를 학생에게 공유하세요.
        </span>
      ) : null}
    </button>
  );
}

/** 최근 활동 상대시간(렌더 중 파생). 값이 없으면 "활동 없음". */
function formatRelative(iso: string | null): string {
  if (!iso) return "활동 없음";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "활동 없음";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "방금 전";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  const week = Math.floor(day / 7);
  if (day < 30) return `${week}주 전`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}개월 전`;
  return `${Math.floor(day / 365)}년 전`;
}
