"use client";

import { useQuery } from "@tanstack/react-query";
import {
  getHomeSummary,
  getHomeSuggestions,
  getSession,
  listCooccurrence,
  listSessions,
  listTags,
  type SpaceTarget,
} from "@/lib/api";
import type {
  CooccurrenceRow,
  HomeSuggestions,
  HomeSummary,
  SessionDetail,
  SessionRow,
  TagRow,
} from "@/lib/types";

export function sessionsKey(target: SpaceTarget) {
  return ["sessions", target.space_kind, target.space_ref ?? null] as const;
}

export function sessionKey(sessionId: string | null) {
  return ["session", sessionId] as const;
}

export function tagsKey(target: SpaceTarget) {
  return ["tags", target.space_kind, target.space_ref ?? null] as const;
}

export function cooccurrenceKey(target: SpaceTarget) {
  return ["cooccurrence", target.space_kind, target.space_ref ?? null] as const;
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

/** 현재 공간의 개념 태그 (usage_count desc). */
export function useTags(target: SpaceTarget) {
  return useQuery<TagRow[]>({
    queryKey: tagsKey(target),
    queryFn: () => listTags(target),
  });
}

/** 현재 공간의 태그 co-occurrence (count desc). */
export function useCooccurrence(target: SpaceTarget) {
  return useQuery<CooccurrenceRow[]>({
    queryKey: cooccurrenceKey(target),
    queryFn: () => listCooccurrence(target),
  });
}

/** 홈 요약(공간/최근 세션/상위 개념). */
export function useHomeSummary() {
  return useQuery<HomeSummary>({
    queryKey: ["home", "summary"],
    queryFn: () => getHomeSummary(),
  });
}

/** 홈 질문 추천(3개). */
export function useHomeSuggestions() {
  return useQuery<HomeSuggestions>({
    queryKey: ["home", "suggestions"],
    queryFn: () => getHomeSuggestions(),
  });
}
