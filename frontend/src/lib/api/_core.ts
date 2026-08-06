/**
 * API 클라이언트 공용 인프라 (D102).
 *
 * 인증 토큰 캐시 · 헤더 조립 · 오류 변환처럼 **모든 도메인 모듈이 공유하는 것**만
 * 둔다. 엔드포인트 함수는 도메인별 형제 모듈(sessions·files·chat…)에 있다.
 *
 * 밑줄 접두사는 "이 폴더 내부용"이라는 표시다 — 앱 코드는 `@/lib/api`(index)만
 * 임포트하고 이 모듈을 직접 참조하지 않는다.
 */
import { clearToken, readToken } from "@/lib/session";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

/**
 * D104-7: 토큰 캐시가 사라졌다.
 *
 * 구성에서는 매 fetch가 `supabase.auth.getSession()`을 await 했고(네트워크 왕복
 * 가능성), 그 비용을 줄이려 메모리 캐시 + 만료 60초 전 갱신 로직을 뒀다. 이제
 * 토큰은 쿠키에 있는 문자열 하나라 읽기가 동기·무비용이다 — 캐시할 대상이 없다.
 *
 * 이 함수는 로그아웃 경로가 계속 호출하므로 유지하되, 쿠키를 지우는 일을 한다.
 */
export function clearTokenCache(): void {
  clearToken();
  // 사람이 바뀌면 **그 사람 것으로 기억해 둔 것도** 버린다. 코치 노브는
  // 사용자별 값은 아니지만, 로그아웃은 "이 브라우저의 상태를 비운다"는 뜻이라
  // 여기서 함께 지우는 편이 다음 사람에게 예측 가능하다.
  onClearCaches.forEach((fn) => fn());
}

/** 로그아웃 때 함께 비울 캐시들. 모듈이 자기 것을 등록한다(순환 임포트 회피). */
const onClearCaches: Array<() => void> = [];

export function registerCacheClear(fn: () => void): void {
  onClearCaches.push(fn);
}

/** 저장된 액세스 토큰을 Authorization 헤더로. */
export async function authHeaders(
  json = false,
): Promise<Record<string, string>> {
  const token = readToken();
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
