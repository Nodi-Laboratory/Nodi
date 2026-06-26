import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Supabase 세션 갱신 + 라우트 보호 (Next.js 16 Proxy 패턴, @supabase/ssr).
 *
 * 보호 대상: (app)/(teacher)/(admin) + 온보딩 → 미로그인 시 /login.
 * 로그인 상태로 /login 진입 시 → /home.
 * 온보딩은 로그인 필요하지만, 로그인 사용자를 강제로 내보내지 않는다(가입 흐름 유지).
 */
const PROTECTED_PREFIXES = [
  "/home",
  "/space",
  "/concepts",
  "/profile",
  "/teacher",
  "/admin",
  "/onboarding",
];

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // 중요: createServerClient와 getUser 사이에 다른 로직을 넣지 않는다.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => path === p || path.startsWith(p + "/"),
  );

  if (!user && isProtected) {
    return redirectKeepingCookies(request, "/login", supabaseResponse);
  }

  if (user && path === "/login") {
    return redirectKeepingCookies(request, "/home", supabaseResponse);
  }

  return supabaseResponse;
}

function redirectKeepingCookies(
  request: NextRequest,
  pathname: string,
  source: NextResponse,
) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  const response = NextResponse.redirect(url);
  // 세션 갱신으로 설정된 쿠키를 리다이렉트 응답에도 전달
  source.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
  return response;
}
