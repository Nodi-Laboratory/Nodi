"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { clearTokenCache } from "@/lib/api";

/**
 * 전역 클라이언트 Provider.
 * - react-query QueryClient(staleTime 60s 기본).
 * - 08 M1: 인증 상태 변화(로그아웃/로그인/토큰 갱신)마다 api.ts의 access_token
 *   메모리 캐시를 무효화해 옛 토큰이 만료 전 재사용되는 것을 막는다(동작 불변 보장).
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  useEffect(() => {
    const supabase = createClient();
    // SIGNED_OUT/SIGNED_IN/TOKEN_REFRESHED 등 어떤 이벤트든 캐시를 비운다.
    // (비우면 다음 호출이 getSession으로 최신 토큰을 다시 읽는다 — 저렴·안전.)
    const { data } = supabase.auth.onAuthStateChange(() => {
      clearTokenCache();
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
