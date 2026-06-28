"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/lib/hooks";
import { roleHome } from "@/lib/roleHome";

/**
 * 역할 가드(D19): allowed에 없는 role이면 자기 전용 페이지로 리다이렉트.
 * /admin·/teacher 등 전용 페이지를 감싸는 데 사용.
 */
export function RoleGuard({
  allowed,
  children,
}: {
  allowed: string[];
  children: ReactNode;
}) {
  const { data: profile, isLoading } = useProfile();
  const router = useRouter();
  const role = profile?.role ?? null;
  const ok = !!role && allowed.includes(role);

  useEffect(() => {
    if (!isLoading && profile && !ok) {
      router.replace(roleHome(role));
    }
  }, [isLoading, profile, ok, role, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg text-sm text-fg-muted">
        불러오는 중…
      </div>
    );
  }
  if (!ok) return null;
  return <>{children}</>;
}
