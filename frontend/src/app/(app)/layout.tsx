import type { ReactNode } from "react";
import IconSidebar from "@/components/sidebar/IconSidebar";
import { StudentShellGuard } from "@/components/auth/StudentShellGuard";
import { ApiKeyFirstRun } from "@/components/settings/ApiKeyFirstRun";

/**
 * (app) 멀티공간 셸.
 * 좌측 64px 아이콘 사이드바 + 우측 콘텐츠 영역.
 * teacher/admin은 학생 페이지 접근 시 자기 전용 페이지로 가드(StudentShellGuard).
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <StudentShellGuard />
      {/* 공개판: 서버에 AI 키가 없으면 첫 진입 때 한 번 입력을 권한다. */}
      <ApiKeyFirstRun />
      <IconSidebar />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
