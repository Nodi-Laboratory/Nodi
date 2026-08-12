/**
 * 내 프로필 · 가입 학급 (D104-7).
 *
 * 구성에서는 프론트가 Supabase 클라이언트로 **DB를 직접 조회**했다(profiles·
 * class_members). Supabase를 걷어내면서 그 경로가 사라졌으므로 백엔드 API를
 * 거친다 — 권한 판정이 서버 한 곳으로 모이는 부수 효과도 있다.
 */
import type { MyClass, Profile } from "@/lib/types";
import { API_BASE, authHeaders, ensureOk } from "./_core";

/** 로그인 사용자의 프로필. 토큰이 없으면 null(로그인 전 화면에서 호출됨). */
export async function getProfile(): Promise<Profile | null> {
  const headers = await authHeaders();
  if (!headers.Authorization) return null;
  const res = await fetch(`${API_BASE}/auth/me`, { headers });
  /**
   * 401은 "아직/더는 로그인 안 됨" — 오류가 아니라 빈 상태다.
   *
   * **404도 같이 본다** (D168). 토큰은 서명·만료가 멀쩡한데 그 계정의 프로필
   * 행이 사라진 경우다(관리자가 계정을 지웠거나 DB를 되돌렸을 때). 그대로
   * 두면 화면은 로그인된 것처럼 뜨지만 세션을 만들 수 없어(FK 위반 502)
   * **입력창이 영원히 잠긴 채 "세션을 준비하는 중"에 머문다** — 실측으로
   * 잡았다(15초를 기다려도 안 열렸다). 없는 계정은 없는 것으로 친다.
   */
  if (res.status === 401 || res.status === 404) return null;
  return (await ensureOk(res)).json();
}

/** 가입한 학급 목록. */
export async function listMyClasses(): Promise<MyClass[]> {
  const headers = await authHeaders();
  if (!headers.Authorization) return [];
  const res = await fetch(`${API_BASE}/auth/me/classes`, { headers });
  if (res.status === 401) return [];
  return (await ensureOk(res)).json();
}

/** 학급 코드로 가입. 잘못된 코드는 404(ApiError.status로 구분). */
export async function joinClass(code: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/auth/me/classes`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ code }),
    }),
  );
}

/**
 * 학급에서 나간다 (사용자 지시 2026-08-12).
 *
 * **지워지는 것은 멤버십 한 행뿐이다** — 그 학급에서 한 대화·카드·올린 파일은
 * 그대로 남는다. 다시 가입하면 그대로 보인다.
 */
export async function leaveClass(classId: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/auth/me/classes/${encodeURIComponent(classId)}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

/** 표시 이름 변경. */
export async function updateDisplayName(displayName: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/auth/me`, {
      method: "PATCH",
      headers: await authHeaders(true),
      body: JSON.stringify({ display_name: displayName }),
    }),
  );
}
