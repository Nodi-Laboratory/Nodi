"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useProfile } from "@/lib/hooks";
import { roleHome } from "@/lib/roleHome";

/**
 * 학생용 (app) 셸 가드(D19): teacher/admin이 학생 페이지(/home·/space·/concepts)에
 * 오면 자기 전용 페이지로 리다이렉트. /profile은 전원 허용(계정 설정).
 * 부작용 전용(렌더 없음).
 */
export function StudentShellGuard() {
  const { data: profile } = useProfile();
  const pathname = usePathname();
  const router = useRouter();
  const role = profile?.role ?? null;

  useEffect(() => {
    if (!role) return;
    if (pathname.startsWith("/profile")) return; // 전원 허용
    if (role === "teacher" || role === "admin") {
      router.replace(roleHome(role));
    }
  }, [role, pathname, router]);

  return null;
}
