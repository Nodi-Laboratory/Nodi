"use client";

import { RoleGuard } from "@/components/auth/RoleGuard";
import { TeacherHome } from "@/components/teacher/TeacherHome";

/**
 * 교사 콘솔 홈 (D67) — 담당 학급 카드 그리드. teacher role만 접근(RoleGuard).
 * 학급 상세는 /teacher/[classId] (ClassDetail).
 */
export default function TeacherPage() {
  return (
    <RoleGuard allowed={["teacher"]}>
      <TeacherHome />
    </RoleGuard>
  );
}
