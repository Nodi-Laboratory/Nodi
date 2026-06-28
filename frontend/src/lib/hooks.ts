"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { MyClass, Profile } from "@/lib/types";

/** 로그인 사용자의 프로필 (react-query 캐시). */
export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: async (): Promise<Profile | null> => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;

      const { data } = await supabase
        .from("profiles")
        .select("id, email, role, display_name, avatar_url, onboarded")
        .eq("id", user.id)
        .single();

      return (data as Profile | null) ?? null;
    },
  });
}

/** 로그인 사용자가 가입한 학급 목록 (class_members ↔ classes). */
export function useMyClasses() {
  return useQuery({
    queryKey: ["my-classes"],
    queryFn: async (): Promise<MyClass[]> => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return [];

      const { data } = await supabase
        .from("class_members")
        .select("class_id, role_in_class, classes(id, name, join_code)")
        .eq("user_id", user.id);

      return (data as unknown as MyClass[]) ?? [];
    },
  });
}
