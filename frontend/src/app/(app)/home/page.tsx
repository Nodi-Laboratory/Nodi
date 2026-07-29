"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { useProfile } from "@/lib/hooks";
import { prefetchSessionData, useHomeSummary } from "@/lib/queries";
import { isRealId } from "@/lib/ids";
import { useStartSession } from "@/lib/useStartSession";
import { useRoutePrefetch } from "@/lib/useRoutePrefetch";
import type { HomeRecentSession, SpaceKind } from "@/lib/types";

/**
 * 최근 대화가 0건일 때의 빈 상태 (D100).
 *
 * 과거에는 "아직 대화가 없습니다." 한 줄이 전부였고, 그 한 줄이 화면 높이만큼
 * 늘어난 카드 좌상단에 덩그러니 놓여 화면이 고장난 것처럼 보였다. 다음 행동을
 * 제시하는 것이 빈 상태의 역할이다.
 */
function EmptyRecent() {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/40 text-accent-fg">
        <MessageSquare size={20} aria-hidden />
      </span>
      <div>
        <p className="text-sm font-medium text-fg">아직 대화가 없습니다</p>
        <p className="mt-1 text-xs text-fg-muted">
          궁금한 것을 물어보면 개념 카드가 캔버스에 펼쳐집니다.
        </p>
      </div>
      <Link
        href="/space/personal"
        className="mt-1 rounded-lg border border-accent-border bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep"
      >
        첫 대화 시작하기
      </Link>
    </div>
  );
}

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

  // D117: 데이터만 선반입하고 **라우트는 클릭 후에** 받고 있었다. 최근 대화가
  // 버튼(router.push)이라 `<Link>`의 자동 프리페치가 걸리지 않는다 — 클릭하고
  // 나서야 RSC 페이로드와 캔버스 청크를 받기 시작한다(프로덕션 빌드 실측
  // 268ms, 배포본은 왕복 220ms가 더 붙는다).
  //
  // 세션이 여러 개여도 목적지 공간은 몇 개 안 된다(개인 + 학급들) — 중복은
  // 훅이 제거한다.
  useRoutePrefetch([
    "/space/personal",
    ...recent.map((s) =>
      s.space_kind === "personal"
        ? "/space/personal"
        : `/space/${s.space_ref ?? "personal"}`,
    ),
  ]);

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

      {/* 최근 대화 — D100: 목록이 있을 때만 남은 높이를 채운다. 과거에는 flex-1이
          무조건 걸려 있어, 대화가 0건일 때도 카드가 화면 끝까지 늘어나고 안에는
          한 줄만 떠 있었다(빈 화면이 고장난 것처럼 보임). */}
      <section
        className={`flex flex-col rounded-xl border border-accent-border/30 bg-bg-elevated ${
          recent.length > 0 ? "min-h-0 flex-1" : ""
        }`}
      >
        <div className="border-b border-accent-border/30 px-5 py-3">
          <h2 className="text-sm font-semibold text-fg">최근 대화</h2>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {summaryLoading ? (
            <p className="px-2 py-3 text-sm text-fg-muted">불러오는 중…</p>
          ) : recent.length === 0 ? (
            <EmptyRecent />
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
