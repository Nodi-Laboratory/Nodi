"use client";

import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { useProfile } from "@/lib/hooks";
import { prefetchSessionData, useHomeSummary } from "@/lib/queries";
import { isRealId } from "@/lib/ids";
import { useStartSession } from "@/lib/useStartSession";
import type { HomeRecentSession, SpaceKind } from "@/lib/types";

/**
 * 홈 화면 — 항상 접근 가능한 진입점. 최근 대화 목록.
 */
export default function HomePage() {
  const { data: profile } = useProfile();
  const { data: summary, isLoading: summaryLoading } = useHomeSummary();
  const { openSession } = useStartSession();
  const queryClient = useQueryClient();

  // 08 G: 최근 대화 hover 시 그 세션 데이터 선반입 → 클릭→워크스페이스 진입이 즉시 채워짐.
  const prefetchRecent = (id: string) => {
    if (isRealId(id)) prefetchSessionData(queryClient, id);
  };

  const displayName = profile?.display_name ?? profile?.email ?? null;
  const recent = summary?.recent_sessions ?? [];

  // iso만으로 결정적 포맷(현재 시각 비교 없음 — 렌더 순수성 유지)
  const formatTime = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
  };

  // space 이름 조회 (recent 세션 표시용)
  const spaceName = (kind: SpaceKind, ref: string | null): string => {
    if (kind === "personal") return "개인 공간";
    const found = summary?.spaces.find(
      (s) => s.space_kind === "class" && s.space_ref === ref,
    );
    return found?.name ?? "학급";
  };

  const handleOpenRecent = (s: HomeRecentSession) => {
    openSession(s.space_kind, s.space_ref, s.id);
  };

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-6 overflow-auto p-8">
      <header>
        <h1 className="text-2xl font-bold text-fg">
          {displayName ? `${displayName} 님, 환영합니다` : "홈"}
        </h1>
        <p className="mt-1 text-sm text-fg-muted">최근 대화를 한눈에.</p>
      </header>

      {/* 최근 대화 */}
      <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-accent-border/30 bg-bg-elevated">
        <div className="border-b border-accent-border/30 px-5 py-3">
          <h2 className="text-sm font-semibold text-fg">최근 대화</h2>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {summaryLoading ? (
            <p className="px-2 py-3 text-sm text-fg-muted">불러오는 중…</p>
          ) : recent.length === 0 ? (
            <p className="px-2 py-3 text-sm text-fg-muted">아직 대화가 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {recent.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => handleOpenRecent(s)}
                    onMouseEnter={() => prefetchRecent(s.id)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/30"
                  >
                    <span className="shrink-0">
                      {s.emoji || (
                        <MessageSquare size={14} className="opacity-60" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-fg">
                      {s.title?.trim() || "새 대화"}
                    </span>
                    <span className="shrink-0 text-xs text-fg-muted">
                      {spaceName(s.space_kind, s.space_ref)}
                    </span>
                    <span className="shrink-0 text-xs text-fg-muted/70">
                      {formatTime(s.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
