"use client";

/**
 * 교차 세션 개념 연결 조회 (D171).
 *
 * ## 왜 폴링이 필요한가
 *
 * 연결은 워커가 만든다 — 턴 안에서 동기로 돌리면 답이 늦어지고, 그건
 * "RAG는 채팅을 절대 막지 않는다"는 불변식을 어긴다. 그래서 턴이 끝난 **뒤에**
 * 결과가 나온다.
 *
 * 대신 그 지연은 대체로 안 보인다: 답은 페이스 타이핑으로 한 글자씩 나오므로
 * (D162) 학생은 그동안 읽고 있다. 3초쯤 뒤 배지가 조용히 붙는다.
 *
 * 무한 폴링은 하지 않는다. 몇 번 확인하고 그만둔다 — 연결이 안 생기는 턴이
 * 대부분이고(게이트가 까다롭다), 안 생긴 것을 계속 확인하는 것은 낭비다.
 * 놓쳐도 다음에 이 세션을 열 때 뜬다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listCrossLinks, openCrossLink, type CrossLink } from "@/lib/api";
import { isRealId } from "@/lib/ids";

/** 턴이 끝나고 첫 확인까지. 사용자 지시 2026-08-04 — 나중에 바꿀 수 있다. */
const FIRST_CHECK_MS = 3000;
/** 그 뒤 확인 간격과 횟수. 워커 폴이 5초라 첫 확인에서 놓칠 수 있다. */
const RETRY_MS = 5000;
const RETRIES = 3;

export function crossLinksKey(sessionId: string | null) {
  return ["cross-links", sessionId] as const;
}

export function useCrossLinks(sessionId: string | null) {
  const qc = useQueryClient();
  const timers = useRef<number[]>([]);
  const [enabled] = useState(true);

  const query = useQuery({
    queryKey: crossLinksKey(sessionId),
    queryFn: (): Promise<CrossLink[]> => listCrossLinks(sessionId as string),
    // 로컬 임시 id인 세션은 서버에 없다 — 부르면 404다.
    enabled: enabled && !!sessionId && isRealId(sessionId),
    /**
     * **배지는 저절로 사라지면 안 된다** (사용자 지시 2026-08-04).
     *
     * staleTime을 짧게 두면 배경 재조회가 돌고, 그 한 번이 실패하거나 빈
     * 목록을 물고 오면 배지가 조용히 사라진다. 학생 눈에는 "있다가 없어졌다"로
     * 보이는데 원인을 짚을 단서가 화면에 하나도 안 남는다.
     *
     * 그래서 **명시적 무효화로만** 다시 읽는다(scheduleCheck·열람 표시).
     * 세션을 다시 열면 어차피 새로 읽는다.
     */
    staleTime: Infinity,
    gcTime: Infinity,
    // 다시 읽는 동안에도 지금 있는 것을 계속 보여 준다 — 깜빡임 방지.
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of t) window.clearTimeout(id);
    };
  }, []);

  /**
   * 턴이 끝났을 때 부른다. 정해진 횟수만 다시 읽고 멈춘다.
   *
   * 이미 걸린 타이머는 지우고 새로 건다 — 학생이 연달아 물으면 확인이
   * 겹겹이 쌓인다.
   */
  const scheduleCheck = useCallback(() => {
    if (!sessionId || !isRealId(sessionId)) return;
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
    for (let i = 0; i <= RETRIES; i++) {
      const delay = FIRST_CHECK_MS + i * RETRY_MS;
      timers.current.push(
        window.setTimeout(() => {
          void qc.invalidateQueries({ queryKey: crossLinksKey(sessionId) });
        }, delay),
      );
    }
  }, [qc, sessionId]);

  const open = useMutation({
    mutationFn: (link: CrossLink) => openCrossLink(link.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: crossLinksKey(sessionId) });
    },
  });

  return {
    links: query.data ?? [],
    scheduleCheck,
    /** 열어 봤다고 표시 — 실패해도 화면은 이미 멈춰 있다(낙관적). */
    markOpened: (link: CrossLink) => open.mutate(link),
  };
}
