/**
 * API 클라이언트 공용 인프라 (D102).
 *
 * 인증 토큰 캐시 · 헤더 조립 · 오류 변환처럼 **모든 도메인 모듈이 공유하는 것**만
 * 둔다. 엔드포인트 함수는 도메인별 형제 모듈(sessions·files·chat…)에 있다.
 *
 * 밑줄 접두사는 "이 폴더 내부용"이라는 표시다 — 앱 코드는 `@/lib/api`(index)만
 * 임포트하고 이 모듈을 직접 참조하지 않는다.
 */
import { apiKeyHeaders } from "@/lib/apiKeys";
import { clearToken } from "@/lib/session";

/**
 * 백엔드 주소. 기본은 **같은 출처 `/api`**다 — 세션이 httpOnly 쿠키라 다른
 * 출처(예: :8000 직접)로 보내면 쿠키가 실리지 않는다. next.config.ts의
 * rewrites가 `/api/*`를 백엔드로 넘긴다(BACKEND_ORIGIN).
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api";

/**
 * 로그아웃 경로가 부른다 — 서버에 쿠키 삭제를 부탁하고, 기억해 둔 것을 비운다.
 * 쿠키가 지워진 **뒤에** 이동해야 하므로 호출부는 await 한다(lib/session.ts).
 */
export async function clearTokenCache(): Promise<void> {
  await clearToken();
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

/**
 * 요청 공용 헤더.
 *
 * 인증은 httpOnly 쿠키가 알아서 실리므로 여기서 하지 않는다. 대신 방문자가
 * 화면에서 넣은 **외부 API 키**를 싣는다(서버 .env에 키가 없을 때만 저장돼
 * 있다 — lib/apiKeys.ts). 서버는 요청 동안만 쓰고 저장하지 않는다.
 */
export async function authHeaders(
  json = false,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...apiKeyHeaders() };
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
