/**
 * 세션(액세스 토큰) 관리 — 자체 인증 (D104-7).
 *
 * 구성에서는 `@supabase/ssr`이 토큰 저장·갱신·쿠키 동기화를 전부 맡았다.
 * 이제 백엔드가 발급한 JWT 하나를 우리가 들고 있으면 된다.
 *
 * 저장 위치는 **쿠키**다. 미들웨어(서버)와 클라이언트가 같은 값을 봐야
 * 라우트 보호가 성립하는데, localStorage는 서버에서 읽을 수 없다.
 *
 * httpOnly가 아닌 이유: 클라이언트 fetch가 Authorization 헤더에 실어야 한다.
 * 대신 만료를 짧게 두고(백엔드 jwt_expire_minutes) SameSite=Lax로 CSRF를 줄인다.
 * XSS가 나면 어차피 httpOnly여도 API를 대신 호출당하므로, 실질 방어는 XSS 차단이다.
 */

export const SESSION_COOKIE = "nodi_token";

/** 쿠키에서 토큰 읽기. 서버 컴포넌트에서는 쓰지 않는다(document 없음). */
export function readToken(): string | null {
  if (typeof document === "undefined") return null;
  const hit = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(SESSION_COOKIE.length + 1)) : null;
}

/** 로그인 성공 시 저장. maxAge는 백엔드 만료와 맞춘다(기본 12시간). */
export function saveToken(token: string, maxAgeSeconds = 60 * 60 * 12): void {
  if (typeof document === "undefined") return;
  document.cookie =
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; path=/; ` +
    `max-age=${maxAgeSeconds}; samesite=lax`;
}

/** 로그아웃 — 쿠키 만료. */
export function clearToken(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
