import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * 라우트 보호 (D104-7).
 *
 * 구성에서는 `@supabase/ssr`이 요청마다 세션을 갱신하고 쿠키를 다시 써야 해서
 * createServerClient + getUser() 왕복이 필요했다. 이제 토큰은 만료가 박힌
 * JWT 하나이므로 **쿠키 존재 여부만** 보면 된다 — 미들웨어에서 네트워크 왕복이
 * 사라졌다.
 *
 * 토큰의 유효성(서명·만료)은 백엔드가 매 요청 검증한다. 미들웨어가 여기서
 * 서명까지 확인하지 않는 이유: 시크릿을 엣지 런타임에 두지 않기 위해서다.
 * 위조 쿠키로 화면은 열려도 데이터는 401이라 아무것도 못 본다.
 */
const PROTECTED_PREFIXES = [
  "/home",
  "/space",
  "/teacher",
  "/admin",
  "/onboarding",
];

/** 로그인한 사용자가 다시 볼 이유가 없는 화면. */
const AUTH_ONLY_PATHS = ["/login", "/signup"];

export async function updateSession(request: NextRequest) {
  const hasToken = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const path = request.nextUrl.pathname;

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => path === p || path.startsWith(p + "/"),
  );

  if (!hasToken && isProtected) {
    return redirectTo(request, "/login");
  }
  if (hasToken && AUTH_ONLY_PATHS.includes(path)) {
    return redirectTo(request, "/home");
  }
  return NextResponse.next({ request });
}

function redirectTo(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return NextResponse.redirect(url);
}
