"use client";

import { useQuery } from "@tanstack/react-query";
import { getSession, listSessions, type SpaceTarget } from "@/lib/api";
import type { SessionDetail, SessionRow } from "@/lib/types";

export function sessionsKey(target: SpaceTarget) {
  return ["sessions", target.space_kind, target.space_ref ?? null] as const;
}

export function sessionKey(sessionId: string | null) {
  return ["session", sessionId] as const;
}

/** 현재 공간의 세션 목록 (updated_at desc, 백엔드 정렬). */
export function useSessions(target: SpaceTarget) {
  return useQuery<SessionRow[]>({
    queryKey: sessionsKey(target),
    queryFn: () => listSessions(target),
  });
}

/** 선택 세션 상세 ({session, nodes[]}). */
export function useSessionDetail(sessionId: string | null) {
  return useQuery<SessionDetail>({
    queryKey: sessionKey(sessionId),
    queryFn: () => getSession(sessionId as string),
    enabled: !!sessionId,
  });
}
