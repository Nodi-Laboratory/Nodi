"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { AuthShell, AuthSwitch, Field } from "@/components/auth/AuthForm";
import { roleHome } from "@/lib/roleHome";

/**
 * 로그인 — 이메일/비밀번호 (D99).
 *
 * Google OAuth를 제거했다. 과거에는 signInWithOAuth → /auth/callback에서
 * role·onboarded를 읽어 분기했는데, 콜백 라우트가 사라졌으므로 그 분기를
 * 여기서 한다: admin→/admin, teacher→/teacher, student→onboarded?/home:/onboarding.
 *
 * 온보딩 미완료 학생을 로그아웃시키던 과거 동작(e49d84d)은 없앴다. 그건 OAuth
 * 왕복 중에는 온보딩 화면으로 보낼 방법이 마땅치 않아 생긴 우회였는데, 이제는
 * 세션을 그대로 두고 /onboarding으로 보내면 된다.
 */
function LoginContent() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 회원가입 직후 이 화면으로 돌아오는 경우의 안내.
  const notice = searchParams.get("signup") === "1" ? "가입이 완료되었습니다. 로그인해 주세요." : null;

  const handleLogin = async () => {
    setError(null);
    setPending(true);

    const supabase = createClient();
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError || !data.user) {
      // Supabase는 계정 없음과 비밀번호 불일치를 같은 오류로 준다(계정 존재
      // 여부 노출 방지). 문구도 구분하지 않는다.
      setError("이메일 또는 비밀번호가 올바르지 않습니다.");
      setPending(false);
      return;
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role, onboarded")
      .eq("id", data.user.id)
      .single();

    // 캐시에 이전 계정 흔적이 남지 않도록 비우고 이동한다.
    queryClient.clear();
    const destination =
      profile?.role === "student" && !profile?.onboarded
        ? "/onboarding"
        : roleHome(profile?.role);
    router.replace(destination);
    router.refresh();
  };

  return (
    <AuthShell
      title="nodi 로그인"
      subtitle="교실에서 함께 쓰는 학습 캔버스"
      onSubmit={handleLogin}
      submitLabel="로그인"
      pendingLabel="로그인 중…"
      pending={pending}
      disabled={!email.trim() || !password}
      error={error}
      notice={error ? null : notice}
      footer={
        <AuthSwitch
          prompt="계정이 없으신가요?"
          href="/signup"
          label="회원가입"
        />
      }
    >
      <Field
        label="이메일"
        type="email"
        name="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Field
        label="비밀번호"
        type="password"
        name="password"
        autoComplete="current-password"
        placeholder="••••••••"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
    </AuthShell>
  );
}

export default function LoginPage() {
  // useSearchParams는 Suspense 경계가 필요하다.
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
