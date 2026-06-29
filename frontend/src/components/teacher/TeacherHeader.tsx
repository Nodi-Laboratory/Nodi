"use client";

import Link from "next/link";
import { School } from "lucide-react";
import { AccountMenu } from "@/components/auth/AccountMenu";

/**
 * D67: 교사 콘솔 공용 헤더. 좌상단 "교사 콘솔"은 `<Link href="/teacher">` —
 * 어느 화면에서나 홈으로 복귀(사용자 요청 핵심). `children`은 빵부스러기 등 보조 슬롯.
 */
export function TeacherHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-accent-border/30 bg-bg-elevated px-6 py-3">
      <Link
        href="/teacher"
        className="flex items-center gap-2 rounded-lg px-1 py-0.5 transition-colors hover:text-accent-deep"
        title="교사 콘솔 홈으로"
      >
        <School size={18} className="text-accent-deep" />
        <h1 className="text-base font-bold">교사 콘솔</h1>
      </Link>

      {children}

      <div className="ml-auto">
        <AccountMenu />
      </div>
    </header>
  );
}
