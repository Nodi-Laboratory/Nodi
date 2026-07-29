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
     *
     * D116: **`api`를 제외한다.** 이 미들웨어가 API 경로에서 하는 일은
     * `NextResponse.next()` 뿐이다 — 보호 대상(PROTECTED_PREFIXES)이 전부
     * 페이지 경로라 API 요청에는 아무 판단도 하지 않는다. 모든 API 호출마다
     * 미들웨어를 한 번씩 태울 이유가 없다.
     *
     * 참고: SSE 버퍼링을 의심해 여기부터 손댔지만 **이건 원인이 아니었다**
     * (제외 후에도 확산 0.00s 그대로). 범인은 rewrites() 프록시였고
     * `app/api/chat/stream/route.ts`로 해결했다.
     */
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
