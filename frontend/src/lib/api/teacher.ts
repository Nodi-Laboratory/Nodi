/** 교사 콘솔 — 학급·학생·개요. api.ts(806줄)에서 분리 — D102. */
import { API_BASE, authHeaders, ensureOk } from "./_core";
import type {
  CreatedClass,
  SessionRow,
  TeacherClassOverview,
  TeacherStudent,
} from "@/lib/types";

// ── 교사 컨트롤 패널 (Stage 4b, teacher role만) ──────────────────────

/** D67: 교사 콘솔 홈 — 학급별 학생수·자료수·최근활동(last_activity_at desc nulls last). */
export async function fetchTeacherOverview(): Promise<TeacherClassOverview[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes/overview`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

/** D33: 교사가 학급 생성. 성공 시 새 학급 row(id·name·join_code 등). */
export async function createClass(name: string): Promise<CreatedClass> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ name }),
    }),
  );
  return res.json();
}

export async function listClassStudents(
  classId: string,
): Promise<TeacherStudent[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes/${classId}/students`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

export async function listStudentClassSessions(
  classId: string,
  userId: string,
): Promise<SessionRow[]> {
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/teacher/classes/${classId}/students/${userId}/sessions`,
      { headers: await authHeaders() },
    ),
  );
  return res.json();
}

