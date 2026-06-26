import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Google OAuth 콜백 (PKCE).
 * code → 세션 교환 후, 가입한 학급(class_members)이 있으면 /home, 없으면 /onboarding.
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

  // 가입 학급 유무로 온보딩/홈 분기
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let destination = "/home";
  if (user) {
    const { count } = await supabase
      .from("class_members")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id);
    destination = count && count > 0 ? "/home" : "/onboarding";
  }

  return NextResponse.redirect(`${origin}${destination}`);
}
