"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * 로그인 페이지.
 * "Google로 로그인" → Supabase OAuth(PKCE) → /auth/callback 으로 복귀.
 * (구글 Provider 설정이 끝나면 실제 동작.)
 */
export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);

  // 콜백 실패 시 ?error=... 로 돌아옴 (useSearchParams 대신 클라이언트에서 직접 파싱)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error")) setCallbackError(params.get("error"));
  }, []);

  const handleGoogleLogin = async () => {
    setError(null);
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setError("로그인을 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.");
      setLoading(false);
    }
    // 성공 시 구글로 리다이렉트되므로 추가 처리 없음.
  };

  return (
    <div className="rounded-2xl border border-accent-border/30 bg-bg-elevated p-8 text-center shadow-sm">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-xl font-bold text-accent-fg">
        n
      </div>
      <h1 className="text-xl font-bold text-fg">nodi 로그인</h1>
      <p className="mt-1 text-sm text-fg-muted">
        AI 대화를 노드·트리로 시각화하는 서비스
      </p>

      <button
        type="button"
        onClick={handleGoogleLogin}
        disabled={loading}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg border border-accent-border bg-white px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-bg disabled:opacity-60"
      >
        {loading ? "이동 중…" : "Google로 로그인"}
      </button>

      {(error || callbackError) && (
        <p className="mt-3 text-xs text-danger">
          {error ?? "로그인에 실패했습니다. 다시 시도해 주세요."}
        </p>
      )}
    </div>
  );
}
