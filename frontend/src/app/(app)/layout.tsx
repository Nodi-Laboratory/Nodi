import type { ReactNode } from "react";
import { IconSidebar } from "@/components/sidebar/IconSidebar";

/**
 * (app) 멀티공간 셸.
 * 좌측 64px 아이콘 사이드바 + 우측 콘텐츠 영역.
 * 홈 / 공간 워크스페이스 / 개념 노드 / 프로필 설정이 이 셸을 공유한다.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <IconSidebar />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
