/**
 * API 클라이언트 공용 인프라 (D102).
 *
 * 인증 토큰 캐시 · 헤더 조립 · 오류 변환처럼 **모든 도메인 모듈이 공유하는 것**만
 * 둔다. 엔드포인트 함수는 도메인별 형제 모듈(sessions·files·chat…)에 있다.
 *
 * 밑줄 접두사는 "이 폴더 내부용"이라는 표시다 — 앱 코드는 `@/lib/api`(index)만
 * 임포트하고 이 모듈을 직접 참조하지 않는다.
 */
import { createClient } from "@/lib/supabase/client";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

/**
 * 08 G(D67): access_token 메모리 캐시. 모든 fetch가 호출당 `getSession()`을 await하던
 * 비용을 줄인다(보통 로컬 캐시지만 보장 없음). expires_at까지 재사용하되 만료 60초 전엔
 * getSession을 다시 불러 supabase가 갱신한 최신 토큰을 받는다(안전 마진).
 */
let tokenCache: { token: string; expiresAtMs: number } | null = null;

/**
 * 08 M1: access_token 캐시 무효화. 인증 상태가 바뀌면(로그아웃/로그인/토큰 갱신)
 * 반드시 호출해 캐시가 만료 전 옛 토큰을 들고 있는 것을 막는다(동작 불변 보장).
 * Providers의 supabase onAuthStateChange가 모든 이벤트에서 호출한다.
 */
export function clearTokenCache(): void {
  tokenCache = null;
}

async function getAccessToken(): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs - 60_000 > now) {
    return tokenCache.token;
  }
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) {
    tokenCache = {
      token: session.access_token,
      // expires_at은 unix 초. 없으면 보수적으로 1분만 캐시.
      expiresAtMs: session.expires_at
        ? session.expires_at * 1000
        : now + 60_000,
    };
    return session.access_token;
  }
  tokenCache = null;
  return null;
}

/** Supabase 세션의 access_token을 Authorization 헤더로. (키 하드코딩 없음) */
export async function authHeaders(
  json = false,
): Promise<Record<string, string>> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/** HTTP 상태 코드를 보존하는 에러(503 등 분기용). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  return res;
}
