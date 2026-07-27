import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/auth/middleware";

/**
 * Next.js 16 Proxy (구 Middleware). 모든 요청 전 라우트 보호.
 *
 * D104: 세션 "갱신"이 사라졌다 — Supabase가 매 요청 쿠키를 다시 쓰던 단계가
 * 없어지고, 토큰 쿠키 존재 여부만 본다(네트워크 왕복 없음).
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * 정적 파일 / 이미지 / 메타를 제외한 모든 경로.
     * (D104: OAuth 콜백 예외가 사라졌다 — 그 라우트 자체가 없다.)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
