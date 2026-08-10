/** 세션 CRUD + 공간(개인/학급) 매핑. api.ts(806줄)에서 분리 — D102. */
import { API_BASE, authHeaders, ensureOk } from "./_core";
import type {
  SessionDetail,
  SessionRow,
  SpaceKind,
} from "@/lib/types";

export interface SpaceTarget {
  space_kind: SpaceKind;
  space_ref?: string | null;
}

/** 라우트의 spaceId → 백엔드 공간 매핑. 'personal' | <class uuid> */
export function spaceTargetFromId(spaceId: string): SpaceTarget {
  if (spaceId === "personal") return { space_kind: "personal" };
  return { space_kind: "class", space_ref: spaceId };
}

export async function listSessions(
  target: SpaceTarget,
  /**
   * 이름으로 찾기 (2026-08-10).
   *
   * 목록에는 상한이 있다(`_LIST_CAP` 200). 그것만 두면 201번째 대화에는 닿을
   * 길이 아예 없다 — 찾기를 서버까지 보내야 상한 밖도 불러올 수 있다.
   */
  q?: string,
): Promise<SessionRow[]> {
  const params = new URLSearchParams({ space_kind: target.space_kind });
  if (target.space_ref) params.set("space_ref", target.space_ref);
  if (q?.trim()) params.set("q", q.trim());
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions?${params.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

export async function createSession(
  target: SpaceTarget,
  title?: string,
): Promise<SessionRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({
        space_kind: target.space_kind,
        space_ref: target.space_ref ?? undefined,
        title,
      }),
    }),
  );
  return res.json();
}

/** 세션 이름 변경(D17). */
export async function patchSession(
  id: string,
  title: string,
): Promise<SessionRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${id}`, {
      method: "PATCH",
      headers: await authHeaders(true),
      body: JSON.stringify({ title }),
    }),
  );
  return res.json();
}

/** 세션 삭제(D17). 204. */
export async function deleteSession(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/sessions/${id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

/** 온보딩 1회 완료 표시(D18). */
/** 온보딩 설문 답 (D222). 전부 선택이라 빈 값도 정상이다. */
export interface OnboardingAnswers {
  display_name: string;
  grade: string;
  stage: string;
  goal: string;
}

/**
 * 설문을 저장한다. 멱등 — 다시 보내면 덮어쓴다.
 *
 * ⚠️ **던지게 두는 것이 맞다.** 호출부가 삼켜서 온보딩을 계속하게 하되,
 * 여기서 조용히 성공한 척하면 저장이 안 되는 것을 아무도 모른다.
 */
export async function saveOnboardingAnswers(
  answers: OnboardingAnswers,
): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/auth/onboarding-answers`, {
      method: "PUT",
      headers: { ...(await authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify(answers),
    }),
  );
}

export async function completeOnboarding(): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/auth/complete-onboarding`, {
      method: "POST",
      headers: await authHeaders(),
    }),
  );
}

export async function getSession(id: string): Promise<SessionDetail> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${id}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

// 공간 쿼리 파라미터 헬퍼(listFiles 등 공용).
export function spaceParams(target: SpaceTarget): URLSearchParams {
  const params = new URLSearchParams({ space_kind: target.space_kind });
  if (target.space_ref) params.set("space_ref", target.space_ref);
  return params;
}

