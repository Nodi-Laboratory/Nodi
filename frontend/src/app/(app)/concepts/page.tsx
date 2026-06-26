"use client";

import { useState } from "react";
import { TreeDeciduous } from "lucide-react";
import { spaceTargetFromId } from "@/lib/api";
import { useCooccurrence, useTags } from "@/lib/queries";
import { useMyClasses } from "@/lib/hooks";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { ConceptCanopy } from "@/components/concepts/ConceptCanopy";

/**
 * 개념 노드 페이지 — 세션 그래프와 분리된 별도 라우트.
 * 현재 공간의 태그 + co-occurrence를 "나무 수관" 디자인으로 보여준다(force-graph 아님).
 * 공간 전환 시 갱신. (열린 질문 B의 1차 시안)
 */
export default function ConceptsPage() {
  const activeSpaceId = useWorkspaceStore((s) => s.activeSpaceId);
  const { data: myClasses = [] } = useMyClasses();
  const [spaceId, setSpaceId] = useState(activeSpaceId);

  const spaces = [
    { id: "personal", label: "개인 공간" },
    ...myClasses.map((m) => ({
      id: m.class_id,
      label: m.classes?.name ?? "학급",
    })),
  ];

  const target = spaceTargetFromId(spaceId);
  const { data: tags, isLoading: tagsLoading } = useTags(target);
  const { data: cooccurrence } = useCooccurrence(target);

  const sortedTags = (tags ?? [])
    .slice()
    .sort((a, b) => b.usage_count - a.usage_count);

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-accent-border/30 bg-bg-elevated px-6 py-3">
        <div className="flex items-center gap-2">
          <TreeDeciduous size={18} className="text-accent-deep" />
          <h1 className="text-sm font-semibold text-fg">개념 나무</h1>
        </div>
        {/* 공간 전환 */}
        <div className="ml-auto flex flex-wrap gap-1">
          {spaces.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSpaceId(s.id)}
              className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                s.id === spaceId
                  ? "bg-accent text-accent-fg"
                  : "text-fg-muted hover:bg-accent/30"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {tagsLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-muted">
            개념을 불러오는 중…
          </div>
        ) : sortedTags.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <TreeDeciduous size={40} className="text-fg-muted opacity-30" />
            <p className="text-sm text-fg-muted">
              아직 개념이 없어요.
              <br />
              대화를 시작하면 개념이 자랍니다.
            </p>
          </div>
        ) : (
          <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_240px]">
            {/* 수관 */}
            <div className="min-h-0 overflow-hidden p-2">
              <ConceptCanopy
                tags={sortedTags}
                cooccurrence={cooccurrence ?? []}
              />
            </div>
            {/* 많이 쓴 개념 목록 (잎이 작아 라벨이 안 보일 때 보조) */}
            <aside className="min-h-0 overflow-auto border-l border-accent-border/30 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                많이 쓴 개념
              </div>
              <ul className="mt-3 flex flex-col gap-1.5">
                {sortedTags.slice(0, 30).map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-2 rounded-lg bg-bg-elevated px-3 py-1.5 text-sm"
                  >
                    <span className="truncate text-fg">#{t.name}</span>
                    <span className="shrink-0 text-xs text-fg-muted">
                      {t.usage_count}
                    </span>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
