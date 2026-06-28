"use client";

import { RoleGuard } from "@/components/auth/RoleGuard";
import { TeacherPanel } from "@/components/teacher/TeacherPanel";

/**
 * 교사 컨트롤 패널 (Stage 4b). teacher role만 접근(D19, RoleGuard).
 * 대화 공간 없이 컨트롤만: 학급 학생 대화 열람(읽기 전용) + 학급 자료실 업로드/임베딩.
 */
export default function TeacherPage() {
  return (
    <RoleGuard allowed={["teacher"]}>
      <TeacherPanel />
    </RoleGuard>
  );
}
