"use client";

/**
 * 이 공간에서 열어야 할 세션을 정한다.
 *
 * 우선순위:
 *   1. 홈에서 넘겨 준 pendingSession (그 공간의 것일 때만)
 *   2. 이미 고른 세션 — **이 공간의 것일 때만** (D148)
 *   3. 이 공간의 가장 최근 세션
 *   4. 없으면 하나 만든다
 *
 * 4번이 중요하다. v1은 세션이 없으면 첫 질문을 보낼 때 만들었는데, 그 사이
 * 캔버스가 "저장할 곳 없는 상태"라 학생이 먼저 글을 쓰거나 그림을 그리면
 * 갈 곳이 없었다. v2는 캔버스 자체가 편집 대상이므로 **들어오는 순간**
 * 저장할 세션이 있어야 한다.
 *
 * ## 2번의 "이 공간의 것일 때만"
 *
 * 예전에는 세션 id가 잡혀 있기만 하면 그대로 열었다. 그래서 개인 공간에
 * 있다가 학급으로 옮기면 **학급 화면에 개인 세션의 대화가 떴다**(사용자
 * 실측 2026-08-02). 보기만 하는 것이 아니라 그 캔버스를 편집하고 질문까지
 * 보낼 수 있어서, 학생 눈에는 학급에서 한 일이 개인 세션에 쌓인다.
 *
 * 세션이 어느 공간 것인지는 스토어가 함께 들고 있다(`activeSessionSpaceId`).
 * 다른 공간 것이면 **없는 것으로 친다** — 그래야 이 훅이 null을 돌려주고,
 * 캔버스는 세션이 정해질 때까지 아무것도 읽거나 보내지 않는다.
 */

import { useCallback, useEffect, useRef } from "react";
import { createSession, listSessions, spaceTargetFromId } from "@/lib/api";
import { isRealId } from "@/lib/ids";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";

export function useSessionBinding(spaceId: string): {
  sessionId: string | null;
  seed: string | null;
  clearSeed: () => void;
  /**
   * 잡고 있던 세션이 **서버에서 사라졌다**고 알린다 (D153).
   *
   * 관리자가 데이터를 초기화했거나 다른 탭에서 지운 경우다. 그대로 두면
   * 화면은 그 id를 계속 붙들고 `/canvas`도 `/chat`도 404를 받는다 — 학생
   * 눈에는 **"질문해도 아무 일도 안 일어난다"**로 보인다(실측으로 잡았다).
   * 표시를 지워 이 공간의 세션을 처음부터 다시 고르게 한다.
   */
  dropSession: () => void;
} {
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const sessionSpaceId = useWorkspaceStore((s) => s.activeSessionSpaceId);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const pending = useWorkspaceStore((s) => s.pendingSession);
  const setPending = useWorkspaceStore((s) => s.setPendingSession);

  /** 이 공간의 세션으로 확정된 것만 밖으로 낸다 (D148). */
  const bound =
    sessionSpaceId === spaceId && isRealId(activeSessionId) ? activeSessionId : null;

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
    setActiveSession(mine.sessionId, spaceId);
    resolvedFor.current = spaceId;
    if (!mine.seed) setPending(null); // 시드가 없으면 바로 소비 완료
  }, [mine, spaceId, setActiveSession, setPending]);

  useEffect(() => {
    if (bound) return;
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
          // 목록은 updated_at desc다(백엔드 정렬) — 가장 최근 대화를 연다.
          setActiveSession(list[0].id, spaceId);
          settled = true;
          return;
        }
        const made = await createSession(target);
        if (!cancelled) {
          setActiveSession(made.id, spaceId);
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
       * 않는다는 원래 보호는 그대로다(성공하면 bound가 차서 위 가드가 막는다).
       */
      if (!settled) resolvedFor.current = null;
    };
  }, [spaceId, bound, setActiveSession]);

  const clearSeed = useCallback(() => setPending(null), [setPending]);

  const dropSession = useCallback(() => {
    // 표시를 지워야 아래 이펙트가 다시 돈다 — 스토어만 비우면 "이 공간은
    // 이미 정했다"는 가드에 막혀 아무도 새 세션을 고르지 않는다.
    resolvedFor.current = null;
    setActiveSession(null);
  }, [setActiveSession]);

  return {
    sessionId: bound,
    seed,
    clearSeed,
    dropSession,
  };
}
