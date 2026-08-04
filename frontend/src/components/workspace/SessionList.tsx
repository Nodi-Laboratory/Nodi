"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  MessageSquare,
  MoreVertical,
  Pencil,
  Trash2,
  Check,
  X,
} from "lucide-react";
import {
  createSession,
  deleteSession,
  patchSession,
  type SpaceTarget,
} from "@/lib/api";
import {
  prefetchSessionData,
  sessionsKey,
  useSessions,
} from "@/lib/queries";
import { isRealId, makeOptimisticId } from "@/lib/ids";
import { SkeletonList } from "@/components/ui/Skeleton";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type { SessionRow } from "@/lib/types";

/**
 * 제목이 아직 없는 대화의 표시 이름 (D173).
 *
 * 예전에는 이것도 "새 대화"였다. 그러면 목록이 이렇게 보인다:
 *
 *     [+ 새 대화]   ← 만드는 **버튼**
 *        새 대화     ← 그냥 제목 없는 **대화**
 *        새 대화
 *
 * 같은 글자가 동작과 항목 둘 다를 뜻해서 어느 쪽이 만들기인지 알 수 없다.
 * 만들기 동작만 "새 대화"라는 이름을 갖는다.
 */
const UNTITLED = "제목 없는 대화";

/**
 * 대화기록 사이드바(좌): 현재 공간의 세션 목록 + "새 대화" + 항목 ⋮(이름변경/삭제).
 * 현재 세션 클릭은 no-op(새 공간 생성 금지, D17 버그 수정).
 */
export function SessionList({
  target,
  onPicked,
}: {
  target: SpaceTarget;
  /**
   * 사용자가 **볼 세션을 정했을 때** 불린다 (D173).
   *
   * 목록을 슬라이드오버로 띄우는 쪽(SessionDrawer)이 스스로 닫으려면 이
   * 신호가 필요하다 — 안 그러면 대화를 골라도 목록이 캔버스를 덮은 채로
   * 남는다(실측: 그 오버레이가 캔버스 클릭을 통째로 먹는다).
   *
   * **자동 선택에는 부르지 않는다.** 목록이 처음 로드되며 첫 세션을 고르는
   * 건 사용자의 결정이 아니다.
   */
  onPicked?: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: sessions, isLoading, isError } = useSessions(target);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const [creating, setCreating] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  // 목록 로드 후 선택된 세션이 없으면 첫 "실제" 세션 자동 선택.
  // 08 F: 낙관(미확정) 행의 임시 id가 active로 잡혀 채팅/영속 경로에 새지 않도록
  // isRealId로 거른다(D63).
  useEffect(() => {
    if (!activeSessionId && sessions && sessions.length > 0) {
      const firstReal = sessions.find((s) => isRealId(s.id));
      if (firstReal) setActiveSession(firstReal.id);
    }
  }, [sessions, activeSessionId, setActiveSession]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: sessionsKey(target) });

  // hover 시 세션 진입 데이터 선반입(D24/08 G) — 클릭 시 이미 캐시.
  // 세션 상세뿐 아니라 그 세션의 파일링크·그래프배치까지 한 번에 prefetch.
  const prefetch = (id: string) => {
    if (!isRealId(id)) return;
    prefetchSessionData(queryClient, id);
  };

  // 08 F: "새 대화"도 낙관 표준 — 클릭 즉시 pending 행을 상단에 띄우고,
  // 서버 확정 시 실데이터로 교체(active 전환은 real id 도착 후) / 실패 시 롤백.
  // active 전환을 real 도착 후로 미루는 이유: 임시 session id가 채팅 전송에 새면
  // 비-UUID session_id로 400이 난다(D63 취지).
  const handleNew = async () => {
    const tempId = makeOptimisticId("session");
    const optimistic: SessionRow = {
      id: tempId,
      title: null,
      root_node_id: null,
      current_head_id: null,
      _pending: true,
    };
    queryClient.setQueryData<SessionRow[]>(sessionsKey(target), (old) => [
      optimistic,
      ...(old ?? []),
    ]);
    setCreating(true);
    try {
      const session = await createSession(target);
      await invalidate(); // 실데이터로 교체(temp 제거)
      setActiveSession(session.id);
      // 만들기가 **성공했을 때만** 닫는다. 실패했는데 닫으면 새 대화가 열린
      // 줄 알고 옛 세션에 질문을 쓰게 된다.
      onPicked?.();
    } catch {
      // 롤백: 낙관 행 제거
      queryClient.setQueryData<SessionRow[]>(sessionsKey(target), (old) =>
        (old ?? []).filter((s) => s.id !== tempId),
      );
    } finally {
      setCreating(false);
    }
  };

  // 세션 선택: 현재 세션이면 no-op(activeNodeId가 null로 초기화돼 빈 화면 되는 버그 방지).
  // 낙관(미확정) 행은 선택 불가(임시 id 차단).
  const handleSelect = (id: string) => {
    // 낙관(미확정) 행은 아직 서버에 없다 — 고를 수 없다.
    if (!isRealId(id)) return;
    // 지금 보고 있는 세션을 다시 누르면 **전환은 없지만 닫기는 한다**.
    // "이거 맞다"는 뜻으로 누른 것인데 목록이 그대로 있으면 고장으로 읽힌다.
    if (id !== activeSessionId) setActiveSession(id);
    onPicked?.();
  };

  const startRename = (s: SessionRow) => {
    setMenuId(null);
    setEditingId(s.id);
    setEditTitle(s.title ?? "");
  };

  // 08 F: 이름변경도 낙관 — 즉시 제목 반영 후 서버 확정 / 실패 시 롤백.
  const saveRename = async (id: string) => {
    const title = editTitle.trim();
    setEditingId(null);
    if (!title) return;
    const prev = queryClient.getQueryData<SessionRow[]>(sessionsKey(target));
    queryClient.setQueryData<SessionRow[]>(sessionsKey(target), (old) =>
      (old ?? []).map((s) => (s.id === id ? { ...s, title } : s)),
    );
    try {
      await patchSession(id, title);
      await invalidate();
    } catch {
      if (prev) queryClient.setQueryData(sessionsKey(target), prev); // 롤백
    }
  };

  // 08 F: 삭제도 낙관 — 즉시 목록에서 제거 + active 이동 후 서버 확정 / 실패 시 롤백.
  const handleDelete = async (s: SessionRow) => {
    setMenuId(null);
    if (!window.confirm(`"${s.title?.trim() || UNTITLED}" 대화를 삭제할까요?`))
      return;
    const prev = queryClient.getQueryData<SessionRow[]>(sessionsKey(target));
    const prevActive = activeSessionId; // 실패 시 선택 상태도 원복
    queryClient.setQueryData<SessionRow[]>(sessionsKey(target), (old) =>
      (old ?? []).filter((x) => x.id !== s.id),
    );
    if (s.id === activeSessionId) {
      const remaining = (sessions ?? []).filter(
        (x) => x.id !== s.id && isRealId(x.id),
      );
      setActiveSession(remaining[0]?.id ?? null);
    }
    try {
      await deleteSession(s.id);
      await invalidate();
    } catch {
      if (prev) queryClient.setQueryData(sessionsKey(target), prev); // 롤백
      setActiveSession(prevActive); // 선택 상태 롤백
    }
  };

  return (
    <aside className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          대화기록
        </span>
        <button
          type="button"
          onClick={handleNew}
          disabled={creating}
          title="새 대화"
          className="flex items-center gap-1 rounded-lg bg-accent-deep px-2 py-1 text-xs font-medium text-white transition-colors hover:brightness-110 disabled:opacity-60"
        >
          <Plus size={14} />
          새 대화
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {isLoading ? (
          <SkeletonList rows={5} className="px-1 py-2" />
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
              const editing = s.id === editingId;
              // 08 F: 낙관(미확정) 행 — 반투명·비상호작용. 서버 확정 시 실행으로 교체.
              if (s._pending) {
                return (
                  <li key={s.id} className="relative">
                    <div className="flex animate-pulse items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg opacity-40">
                      <MessageSquare size={14} className="shrink-0 opacity-70" />
                      <span className="truncate">{UNTITLED}</span>
                    </div>
                  </li>
                );
              }
              return (
                <li key={s.id} className="group relative">
                  {editing ? (
                    <div className="flex items-center gap-1 rounded-lg bg-accent-soft/60 px-2 py-1.5">
                      <input
                        autoFocus
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveRename(s.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="min-w-0 flex-1 rounded border border-accent-border/50 bg-bg px-2 py-1 text-sm text-fg"
                      />
                      <button
                        type="button"
                        onClick={() => saveRename(s.id)}
                        title="저장"
                        className="shrink-0 rounded p-1 text-positive hover:bg-positive/10"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        title="취소"
                        className="shrink-0 rounded p-1 text-fg-muted hover:bg-fg/5"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div
                      className={`flex items-center rounded-lg transition-colors ${
                        active ? "bg-accent text-accent-fg" : "text-fg hover:bg-accent-soft"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelect(s.id)}
                        onMouseEnter={() => prefetch(s.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
                      >
                        <MessageSquare size={14} className="shrink-0 opacity-70" />
                        <span className="truncate">
                          {s.title?.trim() || UNTITLED}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setMenuId(menuId === s.id ? null : s.id)}
                        title="더보기"
                        className="mr-1 shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-black/5 group-hover:opacity-100"
                      >
                        <MoreVertical size={15} />
                      </button>
                    </div>
                  )}

                  {menuId === s.id && !editing && (
                    <SessionMenu
                      onRename={() => startRename(s)}
                      onDelete={() => handleDelete(s)}
                      onClose={() => setMenuId(null)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function SessionMenu({
  onRename,
  onDelete,
  onClose,
}: {
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-1 top-9 z-20 w-32 overflow-hidden rounded-lg border border-accent-border/50 bg-bg-elevated py-1 text-sm shadow-lg"
    >
      <button
        type="button"
        onClick={onRename}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-accent-soft"
      >
        <Pencil size={13} /> 이름 변경
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-danger/10"
      >
        <Trash2 size={13} /> 삭제
      </button>
    </div>
  );
}
