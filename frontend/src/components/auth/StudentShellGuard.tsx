"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useProfile } from "@/lib/hooks";
import { clearTokenCache } from "@/lib/api";
import { roleHome } from "@/lib/roleHome";

/**
 * 학생용 (app) 셸 가드(D19): teacher/admin이 학생 페이지(/home·/space·/concepts)에
 * 오면 자기 전용 페이지로 리다이렉트. /profile은 전원 허용(계정 설정).
 * 부작용 전용(렌더 없음).
 */
export function StudentShellGuard() {
  const { data: profile, isSuccess } = useProfile();
  const pathname = usePathname();
  const router = useRouter();
  const role = profile?.role ?? null;

  /**
   * 프로필이 **없는데 화면은 열려 있는** 상태를 끝낸다 (D168).
   *
   * 토큰만 남고 계정이 사라지면(관리자가 지웠거나 DB를 되돌렸을 때) 미들웨어는
   * 쿠키를 보고 통과시키지만 API는 전부 404·502를 낸다. 학생 눈에는 "화면은
   * 떴는데 아무것도 안 되는" 상태로 보인다 — 입력창이 영원히 잠긴다.
   *
   * 조회가 **성공적으로** null을 돌려줬을 때만 움직인다. 네트워크 실패
   * (isError)로 내보내면 잠깐 끊겼다고 로그아웃되는 셈이라 더 나쁘다.
   */
  useEffect(() => {
    if (!isSuccess || profile) return;
    clearTokenCache();
    router.replace("/login");
  }, [isSuccess, profile, router]);

  useEffect(() => {
    if (!role) return;
    if (pathname.startsWith("/profile")) return; // 전원 허용
    if (role === "teacher" || role === "admin") {
      router.replace(roleHome(role));
    }
  }, [role, pathname, router]);

  return null;
}
