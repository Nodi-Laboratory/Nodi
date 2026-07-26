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

export async function listSessions(target: SpaceTarget): Promise<SessionRow[]> {
  const params = new URLSearchParams({ space_kind: target.space_kind });
  if (target.space_ref) params.set("space_ref", target.space_ref);
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

