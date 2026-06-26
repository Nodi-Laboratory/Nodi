/**
 * 로그인 페이지 스텁.
 * Stage 0: "Google로 로그인" 버튼 자리만 (동작 X).
 * 실제 Supabase Google OAuth 연동은 Stage 0 후속(백엔드 JWT 검증)에서.
 */
export default function LoginPage() {
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
        disabled
        className="mt-6 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg border border-accent-border bg-white px-4 py-2.5 text-sm font-medium text-fg opacity-80"
      >
        Google로 로그인
      </button>
      <p className="mt-3 text-xs text-fg-muted">(연동 예정)</p>
    </div>
  );
}
