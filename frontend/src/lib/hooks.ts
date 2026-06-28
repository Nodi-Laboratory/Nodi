"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { MyClass, Profile } from "@/lib/types";

// D24: getUser()(Auth 서버 왕복) 대신 getSession()(쿠키 로컬)으로 user id를 얻고,
// staleTime/gcTime을 길게 둬 내비게이션마다 재조회/재검증하지 않게 한다.
const PROFILE_STALE = 5 * 60 * 1000; // 5분
const PROFILE_GC = 30 * 60 * 1000; // 30분

/** 로그인 사용자의 프로필 (react-query 캐시). */
export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: async (): Promise<Profile | null> => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return null;

      const { data } = await supabase
        .from("profiles")
        .select("id, email, role, display_name, avatar_url, onboarded")
        .eq("id", user.id)
        .single();

      return (data as Profile | null) ?? null;
    },
    staleTime: PROFILE_STALE,
    gcTime: PROFILE_GC,
  });
}

/** 로그인 사용자가 가입한 학급 목록 (class_members ↔ classes). */
export function useMyClasses() {
  return useQuery({
    queryKey: ["my-classes"],
    queryFn: async (): Promise<MyClass[]> => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return [];

      const { data } = await supabase
        .from("class_members")
        .select("class_id, role_in_class, classes(id, name, join_code)")
        .eq("user_id", user.id);

      return (data as unknown as MyClass[]) ?? [];
    },
    staleTime: PROFILE_STALE,
    gcTime: PROFILE_GC,
  });
}
