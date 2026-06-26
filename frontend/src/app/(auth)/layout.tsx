import type { ReactNode } from "react";

/**
 * (auth) 인증/온보딩 셸 — 사이드바 없는 중앙 정렬 레이아웃.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
