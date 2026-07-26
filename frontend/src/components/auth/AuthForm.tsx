"use client";

import { useId, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

/**
 * 로그인·회원가입이 공유하는 폼 셸 (D99).
 *
 * 두 화면이 같은 골격(로고 → 제목 → 필드 → 제출 → 전환 링크)을 쓰므로 여기에
 * 모으고, 각 화면은 필드만 children으로 채운다. 폼 요소·상태 표시는 화면마다
 * 재구현하지 않는다 — 과거 로그인 화면이 버튼 하나뿐이라 폼 UX(엔터 제출·
 * 에러 영역·비활성 처리)가 아예 없었다.
 */
export function AuthShell({
  title,
  subtitle,
  onSubmit,
  submitLabel,
  pendingLabel,
  pending,
  disabled,
  error,
  notice,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  onSubmit: () => void;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  disabled?: boolean;
  error?: string | null;
  /** 성공·안내 메시지. 오류와 색이 달라야 하므로 슬롯을 분리한다. */
  notice?: string | null;
  footer: ReactNode;
  children: ReactNode;
}) {
  const errorId = useId();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!pending && !disabled) onSubmit();
  };

  return (
    <div className="rounded-2xl border border-accent-border/30 bg-bg-elevated p-8 shadow-sm">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-xl font-bold text-accent-fg">
          n
        </div>
        <h1 className="text-xl font-bold text-fg">{title}</h1>
        <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>
      </div>

      {notice && (
        <p
          role="status"
          className="mt-5 rounded-lg border border-positive/40 bg-positive/5 px-3 py-2 text-center text-xs text-fg"
        >
          {notice}
        </p>
      )}

      {/* form으로 감싸야 엔터 제출·브라우저 자동완성이 동작한다. */}
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
        {children}

        {error && (
          // role=alert: 스크린리더가 제출 실패를 즉시 읽는다.
          <p id={errorId} role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending || disabled}
          aria-describedby={error ? errorId : undefined}
          className="mt-1 w-full rounded-lg border border-accent-border bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? pendingLabel : submitLabel}
        </button>
      </form>

      <div className="mt-4 text-center text-xs text-fg-muted">{footer}</div>
    </div>
  );
}

/** 라벨 + 인풋 한 벌. id를 자동 발급해 label htmlFor를 항상 잇는다. */
export function Field({
  label,
  hint,
  ...input
}: {
  label: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="text-left">
      <label className="text-xs font-medium text-fg-muted" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        aria-describedby={hint ? hintId : undefined}
        {...input}
        className="mt-1 w-full rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-accent-border focus:ring-2 focus:ring-accent/40"
      />
      {hint && (
        <p id={hintId} className="mt-1 text-[11px] text-fg-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/** 인증 화면 하단의 전환 링크(로그인 ↔ 회원가입). */
export function AuthSwitch({
  prompt,
  href,
  label,
}: {
  prompt: string;
  href: string;
  label: string;
}) {
  return (
    <>
      {prompt}{" "}
      <Link
        href={href}
        className="font-medium text-accent-deep underline-offset-2 hover:underline"
      >
        {label}
      </Link>
    </>
  );
}
