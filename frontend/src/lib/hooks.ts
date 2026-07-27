"use client";

import { useQuery } from "@tanstack/react-query";
import { getProfile, listMyClasses } from "@/lib/api";
import type { MyClass, Profile } from "@/lib/types";

// D24: 내비게이션마다 재조회/재검증하지 않도록 staleTime/gcTime을 길게 둔다.
// D104: Supabase 클라이언트로 DB를 직접 조회하던 것을 백엔드 API 호출로 바꿨다.
const PROFILE_STALE = 5 * 60 * 1000; // 5분
const PROFILE_GC = 30 * 60 * 1000; // 30분

/** 로그인 사용자의 프로필 (react-query 캐시). 미로그인은 null. */
export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: (): Promise<Profile | null> => getProfile(),
    staleTime: PROFILE_STALE,
    gcTime: PROFILE_GC,
  });
}

/** 로그인 사용자가 가입한 학급 목록. */
export function useMyClasses() {
  return useQuery({
    queryKey: ["my-classes"],
    queryFn: (): Promise<MyClass[]> => listMyClasses(),
    staleTime: PROFILE_STALE,
    gcTime: PROFILE_GC,
  });
}
