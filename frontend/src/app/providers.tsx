"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { shouldRetry } from "@/lib/retryPolicy";

/**
 * 전역 클라이언트 Provider — react-query QueryClient(staleTime 60s 기본).
 *
 * 인증 상태 구독은 없다 — 세션은 서버가 심는 httpOnly 쿠키 하나이고, 로그인·
 * 로그아웃 시점에 서버가 쓰고 지운다(lib/session.ts).
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
            // D105: 4xx는 재시도하지 않는다 (근거·계약은 lib/retryPolicy).
            retry: shouldRetry,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
