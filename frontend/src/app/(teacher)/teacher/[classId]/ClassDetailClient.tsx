"use client";

import { RoleGuard } from "@/components/auth/RoleGuard";
import { ClassDetail } from "@/components/teacher/ClassDetail";

/**
 * 학급 상세 (D67) — 학생 대화 열람 / 자료실. teacher role만 접근(RoleGuard).
 * 홈(/teacher)에서 카드 클릭으로 진입.
 */
export function ClassDetailClient({ classId }: { classId: string }) {
  return (
    <RoleGuard allowed={["teacher"]}>
      <ClassDetail key={classId} classId={classId} />
    </RoleGuard>
  );
}
