import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Google OAuth 콜백 (PKCE).
 * code → 세션 교환 후, role·onboarded로 진입 분기(D18/D19):
 * admin→/admin, teacher→/teacher, student→ onboarded?/home:signOut 후 /login(재로그인 유도).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const errorParam = searchParams.get("error");

  if (errorParam) {
    return NextResponse.redirect(`${origin}/login?error=${errorParam}`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let destination = "/home";
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, onboarded")
      .eq("id", user.id)
      .single();
    const role = profile?.role;
    if (role === "admin") destination = "/admin";
    else if (role === "teacher") destination = "/teacher";
    else if (profile?.onboarded) destination = "/home";
    else {
      // onboarded=false: 미들웨어의 "로그인 상태 /login → /home" 규칙에 걸리지
      // 않도록 세션을 정리한 뒤 재로그인시킨다.
      await supabase.auth.signOut();
      destination = "/login?error=not_onboarded";
    }
  }

  return NextResponse.redirect(`${origin}${destination}`);
}
