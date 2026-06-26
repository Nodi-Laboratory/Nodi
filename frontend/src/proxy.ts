import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Next.js 16 Proxy (구 Middleware). 모든 요청 전 Supabase 세션 갱신 + 라우트 보호.
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * 정적 파일 / 이미지 / 메타 / OAuth 콜백을 제외한 모든 경로.
     * (auth/callback은 자체 쿠키 교환을 하므로 Proxy 대상에서 제외)
     */
    "/((?!_next/static|_next/image|favicon.ico|auth/callback|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
