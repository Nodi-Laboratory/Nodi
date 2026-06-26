"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, MessageSquare } from "lucide-react";
import { createSession, type SpaceTarget } from "@/lib/api";
import { sessionsKey, useSessions } from "@/lib/queries";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";

/**
 * 대화기록 사이드바(좌): 현재 공간의 세션 목록 + "새 대화".
 */
export function SessionList({ target }: { target: SpaceTarget }) {
  const queryClient = useQueryClient();
  const { data: sessions, isLoading, isError } = useSessions(target);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const [creating, setCreating] = useState(false);

  // 목록 로드 후 선택된 세션이 없으면 첫 세션 자동 선택
  useEffect(() => {
    if (!activeSessionId && sessions && sessions.length > 0) {
      setActiveSession(sessions[0].id);
    }
  }, [sessions, activeSessionId, setActiveSession]);

  const handleNew = async () => {
    setCreating(true);
    try {
      const session = await createSession(target);
      await queryClient.invalidateQueries({ queryKey: sessionsKey(target) });
      setActiveSession(session.id);
    } catch {
      // 실패 시 조용히 무시(상단 토스트는 이후 단계)
    } finally {
      setCreating(false);
    }
  };

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-accent-border/30">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          대화기록
        </span>
        <button
          type="button"
          onClick={handleNew}
          disabled={creating}
          title="새 대화"
          className="flex items-center gap-1 rounded-lg border border-accent-border bg-accent px-2 py-1 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
        >
          <Plus size={14} />
          새 대화
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {isLoading ? (
          <p className="px-2 py-3 text-sm text-fg-muted">불러오는 중…</p>
        ) : isError ? (
          <p className="px-2 py-3 text-sm text-danger">
            세션을 불러오지 못했습니다.
          </p>
        ) : !sessions || sessions.length === 0 ? (
          <p className="px-2 py-3 text-sm text-fg-muted">
            대화가 없습니다. &quot;새 대화&quot;로 시작하세요.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sessions.map((s) => {
              const active = s.id === activeSessionId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setActiveSession(s.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      active
                        ? "bg-accent text-accent-fg"
                        : "text-fg hover:bg-accent/30"
                    }`}
                  >
                    <MessageSquare size={14} className="shrink-0 opacity-70" />
                    <span className="truncate">
                      {s.title?.trim() || "새 대화"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
