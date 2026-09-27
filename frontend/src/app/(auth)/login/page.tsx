"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { authErrorMessage, getProfile, login } from "@/lib/api";
import { AuthShell, AuthSwitch, Field } from "@/components/auth/AuthForm";
import { roleHome } from "@/lib/roleHome";

/**
 * 로그인 — 아이디(또는 이메일) + 비밀번호 (D99, 공개판 2026-09-27).
 *
 * 로그인 뒤 역할로 분기한다: admin→/admin, teacher→/teacher,
 * student→onboarded?/home:/onboarding.
 */
function LoginContent() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 회원가입 직후 이 화면으로 돌아오는 경우의 안내.
  const notice = searchParams.get("signup") === "1" ? "가입이 완료되었습니다. 로그인해 주세요." : null;

  const handleLogin = async () => {
    setError(null);
    setPending(true);

    try {
      // 성공하면 서버가 httpOnly 세션 쿠키를 심는다 — 이어지는 조회가 인증된다.
      await login(identifier.trim(), password);
      // 캐시에 이전 계정 흔적이 남지 않도록 비우고 이동한다.
      queryClient.clear();

      const profile = await getProfile();
      const destination =
        profile?.role === "student" && !profile?.onboarded
          ? "/onboarding"
          : roleHome(profile?.role);
      router.replace(destination);
      router.refresh();
    } catch (err) {
      // 서버가 계정 없음과 비밀번호 불일치를 같은 401로 준다(계정 존재 여부
      // 노출 방지) — 프론트에서 다시 갈라 쓰지 않는다.
      setError(
        authErrorMessage(err, "아이디(이메일) 또는 비밀번호가 올바르지 않습니다."),
      );
      setPending(false);
    }
  };

  return (
    <AuthShell
      title="nodi 로그인"
      subtitle="교실에서 함께 쓰는 학습 캔버스"
      onSubmit={handleLogin}
      submitLabel="로그인"
      pendingLabel="로그인 중…"
      pending={pending}
      disabled={!identifier.trim() || !password}
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
        label="아이디 또는 이메일"
        type="text"
        name="username"
        autoComplete="username"
        placeholder="demo 또는 you@example.com"
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
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
