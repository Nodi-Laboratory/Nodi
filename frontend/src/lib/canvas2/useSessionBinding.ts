"use client";

/**
 * 이 공간에서 열어야 할 세션을 정한다.
 *
 * 우선순위:
 *   1. 홈에서 넘겨 준 pendingSession (그 공간의 것일 때만)
 *   2. 이미 고른 세션
 *   3. 이 공간의 가장 최근 세션
 *   4. 없으면 하나 만든다
 *
 * 4번이 중요하다. v1은 세션이 없으면 첫 질문을 보낼 때 만들었는데, 그 사이
 * 캔버스가 "저장할 곳 없는 상태"라 학생이 먼저 글을 쓰거나 그림을 그리면
 * 갈 곳이 없었다. v2는 캔버스 자체가 편집 대상이므로 **들어오는 순간**
 * 저장할 세션이 있어야 한다.
 */

import { useCallback, useEffect, useRef } from "react";
import { createSession, listSessions, spaceTargetFromId } from "@/lib/api";
import { isRealId } from "@/lib/ids";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";

export function useSessionBinding(spaceId: string): {
  sessionId: string | null;
  seed: string | null;
  clearSeed: () => void;
} {
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const pending = useWorkspaceStore((s) => s.pendingSession);
  const setPending = useWorkspaceStore((s) => s.setPendingSession);

  // 공간마다 한 번만 자동 선택한다. 학생이 세션을 지우고 목록이 비었을 때
  // 계속 새 세션을 만들어 대는 걸 막는다.
  const resolvedFor = useRef<string | null>(null);

  // 시드 질문은 **스토어에 그대로 둔다.** 로컬 state로 복사하면 이펙트에서
  // setState를 부르게 되고(연쇄 렌더), 두 곳에 같은 값이 생겨 어느 쪽이
  // 진실인지 흐려진다. 소비자가 다 쓰면 clearSeed로 스토어에서 지운다.
  const mine = pending && pending.spaceId === spaceId ? pending : null;
  const seed = mine?.seed ?? null;

  useEffect(() => {
    if (!mine) return;
    // zustand 스토어 갱신이다 — React state가 아니라 외부 시스템 동기화.
    setActiveSession(mine.sessionId);
    resolvedFor.current = spaceId;
    if (!mine.seed) setPending(null); // 시드가 없으면 바로 소비 완료
  }, [mine, spaceId, setActiveSession, setPending]);

  useEffect(() => {
    if (isRealId(activeSessionId)) return;
    if (resolvedFor.current === spaceId) return;
    resolvedFor.current = spaceId;

    let cancelled = false;
    /** 이번 시도가 끝까지 갔나. 안 갔으면 표시를 되돌려 다시 시도하게 둔다. */
    let settled = false;
    const target = spaceTargetFromId(spaceId);
    void (async () => {
      try {
        const list = await listSessions(target);
        if (cancelled) return;
        if (list.length) {
          setActiveSession(list[0].id);
          settled = true;
          return;
        }
        const made = await createSession(target);
        if (!cancelled) {
          setActiveSession(made.id);
          settled = true;
        }
      } catch {
        // 세션을 못 만들면 캔버스는 읽기 전용으로 뜬다. 상위가 배너를 띄운다.
        if (!cancelled) resolvedFor.current = null;
      }
    })();
    return () => {
      cancelled = true;
      /**
       * **끝내지 못한 시도는 표시를 지운다.**
       *
       * 표시를 비동기 작업 *전에* 찍는데, 개발의 React StrictMode는 이펙트를
       * mount → cleanup → mount로 두 번 돌린다. 1차가 표시를 찍고 시작한 조회는
       * cleanup에서 취소되고, 2차는 "이미 해결했다"며 그냥 돌아온다 — **아무도
       * 세션을 정하지 않은 채 끝난다.**
       *
       * 실측(2026-07-31): 홈에서 링크로 캔버스에 들어가면 `/canvas` 요청이 아예
       * 나가지 않고 입력창이 "세션을 준비하는 중이에요"로 영구히 비활성이었다.
       * 같은 주소를 새로고침하면 정상이라 눈에 잘 안 띄었다.
       *
       * 완료한 시도만 표시를 남기므로, 세션이 없을 때 새로 만드는 일이 반복되지
       * 않는다는 원래 보호는 그대로다(성공하면 activeSessionId가 차서 위 가드가 막는다).
       */
      if (!settled) resolvedFor.current = null;
    };
  }, [spaceId, activeSessionId, setActiveSession]);

  const clearSeed = useCallback(() => setPending(null), [setPending]);

  return {
    sessionId: isRealId(activeSessionId) ? activeSessionId : null,
    seed,
    clearSeed,
  };
}
