"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Map as MapIcon, MessageSquare } from "lucide-react";
import { ConceptMap } from "@/components/home/ConceptMap";
import { useProfile } from "@/lib/hooks";
import { useConceptMap, useHomeSummary } from "@/lib/queries";
import { useRoutePrefetch } from "@/lib/useRoutePrefetch";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type { ConceptNode } from "@/lib/api/conceptMap";

/**
 * 개념이 아직 없을 때 (D189).
 *
 * 빈 지도는 **고장난 화면과 구분되지 않는다** — 회색 판만 남는다. 무엇을 하면
 * 여기가 채워지는지 말해 주는 것이 빈 상태의 역할이다(D100과 같은 태도).
 */
function EmptyMap() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent-fg">
        <MapIcon size={22} aria-hidden />
      </span>
      <div>
        <p className="text-sm font-medium text-fg">아직 지도에 올릴 개념이 없습니다</p>
        <p className="mt-1 text-xs text-fg-muted">
          질문을 하면 개념 카드가 쌓이고, 비슷한 개념끼리 여기서 뭉칩니다.
        </p>
      </div>
      <Link
        href="/space/personal"
        className="mt-1 rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep"
      >
        첫 대화 시작하기
      </Link>
    </div>
  );
}

/**
 * 홈 — 개념 지도 대시보드 (D189).
 *
 * 예전 홈은 최근 대화 **목록**이었다. 목록은 "언제 했는지"만 말해 준다. 학생이
 * 알고 싶은 것은 "내가 무엇을 아는가"와 "그것들이 어떻게 이어지는가"이고,
 * 그건 목록으로는 안 보인다.
 */
export default function HomePage() {
  const { data: profile } = useProfile();
  const { data: summary } = useHomeSummary();
  const { data: map, isLoading, isError } = useConceptMap();
  const router = useRouter();
  const setPendingFocusItem = useWorkspaceStore((s) => s.setPendingFocusItem);
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);

  const displayName = profile?.display_name ?? profile?.email ?? null;
  const spaceIds = (summary?.spaces ?? []).map((s) =>
    s.space_kind === "personal" ? "/space/personal" : `/space/${s.space_ref}`,
  );
  useRoutePrefetch(["/space/personal", ...spaceIds]);

  /**
   * 개념을 누르면 **그 대화의 그 카드**로 간다.
   *
   * 도착해서 바로 초점을 맞출 수는 없다 — 목적지 세션은 아직 안 채워져 있고
   * 수화는 비동기다(D147). "가서 이 카드를 보여 달라"를 스토어에 남기면
   * 캔버스가 그 카드를 실제로 갖게 됐을 때 소비한다. 교차 링크(D171)가 다른
   * 세션으로 건너뛸 때 쓰는 길과 **같은 길**이다.
   */
  const openConcept = (node: ConceptNode) => {
    const session = map?.sessions.find((s) => s.id === node.session_id);
    if (!session) return;
    const spaceId =
      session.space_kind === "class" && session.space_ref
        ? session.space_ref
        : "personal";
    setPendingFocusItem(node.id);
    setActiveSpace(spaceId);
    setActiveSession(session.id, spaceId);
    router.push(`/space/${spaceId}`);
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="shrink-0">
        <h1 className="text-2xl font-bold text-fg">
          {displayName ? `${displayName} 님의 개념 지도` : "개념 지도"}
        </h1>
        <p className="mt-1 text-sm text-fg-muted">
          지금까지 대화한 개념이 비슷한 것끼리 뭉쳐 있습니다. 확대하면 낱개가
          보이고, 누르면 그 대화로 갑니다.
        </p>
      </header>

      {/* 대시보드의 큰 박스 하나 — 남은 높이를 전부 쓴다. */}
      <section className="min-h-0 flex-1 overflow-hidden rounded-xl border border-accent-border/30 bg-bg-elevated">
        {isLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            개념을 모으는 중…
          </div>
        ) : isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-sm text-fg">지도를 불러오지 못했습니다</p>
            <p className="text-xs text-fg-muted">
              잠시 뒤 다시 열어 보세요. 대화 기록은 그대로 있습니다.
            </p>
          </div>
        ) : !map || map.nodes.length === 0 ? (
          <EmptyMap />
        ) : (
          <ConceptMap data={map} onOpen={openConcept} />
        )}
      </section>

      {/* 지도가 답하지 못하는 것 하나 — "방금 하던 대화로 돌아가기". */}
      {summary && summary.recent_sessions.length > 0 && (
        <footer className="flex shrink-0 items-center gap-2 overflow-x-auto text-xs">
          <span className="shrink-0 text-fg-muted">최근 대화</span>
          {summary.recent_sessions.slice(0, 5).map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                const spaceId =
                  s.space_kind === "class" && s.space_ref ? s.space_ref : "personal";
                setActiveSpace(spaceId);
                setActiveSession(s.id, spaceId);
                router.push(`/space/${spaceId}`);
              }}
              className="flex shrink-0 items-center gap-1 rounded-full border border-accent-border/40 px-3 py-1 text-fg transition-colors hover:bg-accent-soft"
            >
              <span aria-hidden>
                {s.emoji || <MessageSquare size={11} className="opacity-60" />}
              </span>
              <span className="max-w-40 truncate">
                {s.title?.trim() || "제목 없는 대화"}
              </span>
            </button>
          ))}
        </footer>
      )}
    </div>
  );
}
