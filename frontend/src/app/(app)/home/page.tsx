"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Map as MapIcon } from "lucide-react";
import { ConceptMap } from "@/components/home/ConceptMap";
import { MapSessionTree } from "@/components/home/MapSessionTree";
import { useProfile } from "@/lib/hooks";
import {
  loadCollapsedFolders,
  loadHiddenSessions,
  saveCollapsedFolders,
  saveHiddenSessions,
} from "@/lib/home/mapPrefs";
import {
  buildSessionTree,
  pruneHidden,
  toggleFolder,
  toggleSession,
  type SessionFolder,
} from "@/lib/home/sessionTree";
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
   * 지도에 무엇을 띄울지 (D191).
   *
   * 저장값을 `useState` 초기화에서 읽는다 — `mapPrefs`가 `window` 부재까지
   * 삼키므로 서버 렌더에서는 빈 집합이 나오고, 그때 화면은 아직 로딩 상태라
   * 하이드레이션이 어긋날 자리가 없다.
   */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(loadHiddenSessions()),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(loadCollapsedFolders()),
  );

  const folders = useMemo(
    () => buildSessionTree(map?.nodes ?? [], map?.sessions ?? [], summary?.spaces ?? []),
    [map, summary],
  );

  /**
   * 저장은 **걸러서** 한다.
   *
   * 유령 id를 `setHidden`으로 정리하면 이펙트 안의 setState가 되는데(React
   * Compiler 규칙이 막는다) 그럴 이유도 없다 — 없는 id는 화면에서 아무것도
   * 안 가리므로, 저장하는 순간에만 털어 내면 값이 무한히 자라지 않는다.
   */
  useEffect(() => {
    saveHiddenSessions(pruneHidden(hidden, folders));
  }, [hidden, folders]);

  useEffect(() => {
    saveCollapsedFolders(collapsed);
  }, [collapsed]);

  const handleToggleSession = useCallback(
    (id: string) => setHidden((h) => toggleSession(h, id)),
    [],
  );
  const handleToggleFolder = useCallback(
    (f: SessionFolder) => setHidden((h) => toggleFolder(h, f)),
    [],
  );
  const handleToggleCollapse = useCallback(
    (key: string) =>
      setCollapsed((c) => {
        const next = new Set(c);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  const handleShowAll = useCallback(() => setHidden(new Set<string>()), []);

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
          보이고, 누르면 그 대화로 갑니다. 오른쪽에서 볼 대화를 고르세요.
        </p>
      </header>

      {/*
        지도 박스 (D191).

        **남은 높이를 다 쓴다** (사용자 지시 2026-08-06). 상한 620을 걸었더니
        아래에 빈 자리가 크게 남아 박스가 화면 위쪽에 떠 있는 꼴이 됐다 —
        "가운데가 아니다"의 정체가 그것이었다. 최근 대화 줄을 걷어낸 지금
        (같은 지시) 박스 밑에 올 것이 없으므로 남길 여백도 없다.

        페이지 여백(p-6)이 박스를 화면에서 떼어 놓는 일을 대신한다 — 그래서
        "페이지"와 "지도"의 경계는 그대로 보인다. 좌우는 `mx-auto`로 가운데에
        두되 아주 넓은 화면에서만 상한이 걸린다.

        테두리를 3px로 세운다. 목록이 박스 **안**이라 테두리 하나가 목록과
        지도를 함께 감싼다 — 둘이 한 물건이라는 표시다.
      */}
      <section className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 overflow-hidden rounded-xl border-[3px] border-accent-border/70 bg-bg-elevated shadow-sm">
        {isLoading ? (
          <div className="flex h-full w-full items-center justify-center gap-2 text-sm text-fg-muted">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            개념을 모으는 중…
          </div>
        ) : isError ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-sm text-fg">지도를 불러오지 못했습니다</p>
            <p className="text-xs text-fg-muted">
              잠시 뒤 다시 열어 보세요. 대화 기록은 그대로 있습니다.
            </p>
          </div>
        ) : !map || map.nodes.length === 0 ? (
          <div className="h-full w-full">
            <EmptyMap />
          </div>
        ) : (
          <>
            {/* 목록은 **오른쪽**이다(사용자 지시 2026-08-06) — 지도가 왼쪽 끝에서 시작한다. */}
            <div className="min-w-0 flex-1">
              <ConceptMap data={map} onOpen={openConcept} hiddenSessions={hidden} />
            </div>
            <MapSessionTree
              folders={folders}
              hidden={hidden}
              collapsed={collapsed}
              onToggleSession={handleToggleSession}
              onToggleFolder={handleToggleFolder}
              onToggleCollapse={handleToggleCollapse}
              onShowAll={handleShowAll}
            />
          </>
        )}
      </section>
    </div>
  );
}
