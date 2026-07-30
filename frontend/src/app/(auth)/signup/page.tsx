"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { authErrorMessage, signup } from "@/lib/api";
import { saveToken } from "@/lib/session";
import { AuthShell, AuthSwitch, Field } from "@/components/auth/AuthForm";
import { roleHome } from "@/lib/roleHome";

/** Supabase 기본 최소 길이는 6이지만, 교실 계정이라 조금 더 올린다. */
const MIN_PASSWORD = 8;

/**
 * 회원가입 — 이메일/비밀번호 (D99).
 *
 * 역할은 `raw_user_meta_data.role`로 넘기고, 마이그레이션 0041의
 * handle_new_user 트리거가 화이트리스트('student'|'teacher')를 강제해 프로필에
 * 반영한다. **클라이언트 값을 그대로 믿지 않는다** — admin은 여기서 선택할 수
 * 없고 admin_set_user_role로만 부여된다.
 *
 * 이메일 확인이 꺼진 환경(로컬 config.toml)에서는 signUp이 곧바로 세션을 주므로
 * 그대로 진입시키고, 확인이 켜진 환경에서는 세션이 없으므로 로그인 화면으로
 * 안내한다. 두 경우를 session 유무로 구분한다.
 */
type Role = "student" | "teacher";

export default function SignupPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [role, setRole] = useState<Role>("student");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = passwordConfirm.length > 0 && password !== passwordConfirm;
  const canSubmit =
    !!displayName.trim() &&
    !!email.trim() &&
    password.length >= MIN_PASSWORD &&
    password === passwordConfirm;

  const handleSignup = async () => {
    setError(null);
    setPending(true);

    try {
      const auth = await signup({
        email: email.trim(),
        password,
        display_name: displayName.trim() || null,
        role,
      });
      // 가입과 동시에 로그인 상태가 된다(이메일 확인 단계 없음).
      saveToken(auth.access_token);
      queryClient.clear();
      // 학생은 온보딩(학급 코드), 교사는 콘솔로.
      router.replace(role === "student" ? "/onboarding" : roleHome(role));
      router.refresh();
    } catch (err) {
      setError(
        authErrorMessage(
          err,
          "가입에 실패했습니다. 입력을 확인하고 다시 시도해 주세요.",
        ),
      );
      setPending(false);
    }
  };

  return (
    <AuthShell
      title="nodi 회원가입"
      subtitle="교실에서 함께 쓰는 학습 캔버스"
      onSubmit={handleSignup}
      submitLabel="가입하기"
      pendingLabel="가입 중…"
      pending={pending}
      disabled={!canSubmit}
      error={error}
      footer={
        <AuthSwitch prompt="이미 계정이 있으신가요?" href="/login" label="로그인" />
      }
    >
      <div className="text-left">
        <span className="text-xs font-medium text-fg-muted">역할</span>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {(
            [
              { value: "student", label: "학생", hint: "학급에 참여" },
              { value: "teacher", label: "선생님", hint: "학급을 개설" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setRole(opt.value)}
              aria-pressed={role === opt.value}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                role === opt.value
                  ? "border-accent-border bg-accent-soft text-accent-fg"
                  : "border-accent-border/50 bg-bg text-fg hover:bg-accent-soft/60"
              }`}
            >
              <span className="block text-sm font-medium">{opt.label}</span>
              <span className="block text-[11px] opacity-70">{opt.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <Field
        label="이름"
        type="text"
        name="name"
        autoComplete="name"
        placeholder="김노디"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        required
      />
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
        name="new-password"
        autoComplete="new-password"
        placeholder="••••••••"
        hint={
          tooShort ? `${MIN_PASSWORD}자 이상 입력해 주세요.` : `${MIN_PASSWORD}자 이상`
        }
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <Field
        label="비밀번호 확인"
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        placeholder="••••••••"
        hint={mismatch ? "비밀번호가 일치하지 않습니다." : undefined}
        value={passwordConfirm}
        onChange={(e) => setPasswordConfirm(e.target.value)}
        required
      />
    </AuthShell>
  );
}
