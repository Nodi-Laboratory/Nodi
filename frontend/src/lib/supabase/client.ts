import { createBrowserClient } from "@supabase/ssr";

/**
 * 브라우저(클라이언트 컴포넌트)용 Supabase 클라이언트.
 * Stage 0: 골격만. 실제 키는 .env.local(NEXT_PUBLIC_*)에서 주입 — 하드코딩 금지.
 * 키 연결은 Supabase 프로젝트 셋업 후 채운다.
 */
export function createBrowserSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Supabase 환경변수(NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)가 설정되지 않았습니다. .env.local을 확인하세요.",
    );
  }

  return createBrowserClient(url, anonKey);
}
