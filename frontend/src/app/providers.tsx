"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * 전역 클라이언트 Provider — react-query QueryClient(staleTime 60s 기본).
 *
 * D104: 인증 상태 변화 구독이 사라졌다. 구성에서는 Supabase가 토큰을 자체
 * 갱신했기 때문에 onAuthStateChange로 그 시점을 잡아 프론트 토큰 캐시를
 * 무효화해야 했다. 이제 토큰은 쿠키의 문자열 하나이고 캐시가 없다 — 로그인·
 * 로그아웃 시점에 쿠키를 직접 쓰고 지우므로 구독할 대상이 없다.
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

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
