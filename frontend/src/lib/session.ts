/**
 * 세션 — httpOnly 쿠키 (공개판 2026-09-27, 구 D104-7).
 *
 * 토큰은 백엔드가 로그인·가입 응답에서 **httpOnly 쿠키**로 심는다. 브라우저 JS는
 * 토큰을 읽지도 쓰지도 않는다 — XSS가 나도 토큰 자체는 빼 갈 수 없다.
 *
 * 요청은 전부 같은 출처(`/api`, next.config.ts rewrites)로 나가므로 브라우저가
 * 쿠키를 알아서 싣는다. 라우트 보호 미들웨어(lib/auth/middleware.ts)는 서버에서
 * 이 쿠키의 **존재**만 본다(검증은 백엔드가 매 요청).
 *
 * httpOnly라 JS가 지울 수 없으므로 로그아웃은 서버에 부탁한다(`clearToken`).
 */

/** 백엔드 auth/deps.py SESSION_COOKIE와 같아야 한다. */
export const SESSION_COOKIE = "nodi_token";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api";

/**
 * 로그아웃 — 서버가 쿠키를 지운다.
 *
 * **기다린 뒤에 이동해야 한다.** 쿠키가 남은 채 /login으로 가면 미들웨어가
 * "로그인한 사람"으로 보고 /home으로 되돌려 보낸다. 네트워크가 실패해도
 * 던지지 않는다 — 로그아웃 버튼이 오류로 막히는 것보다 낫다.
 */
export async function clearToken(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
    });
  } catch {
    /* 오프라인 등 — 쿠키는 만료로 사라진다 */
  }
}
