/**
 * 온보딩(학급코드) 페이지 스텁.
 * Stage 0: "연결할 학급이 있습니까?" + 학급코드 입력 자리 (동작 X).
 * 학급 없이도 진행 가능. 실제 class-join 연동은 후속 단계.
 */
export default function OnboardingPage() {
  return (
    <div className="rounded-2xl border border-accent-border/30 bg-bg-elevated p-8 shadow-sm">
      <h1 className="text-xl font-bold text-fg">시작하기</h1>
      <p className="mt-2 text-sm text-fg-muted">연결할 학급이 있습니까?</p>

      <div className="mt-5">
        <label className="text-xs font-medium text-fg-muted" htmlFor="join-code">
          학급 코드 (선택)
        </label>
        <input
          id="join-code"
          type="text"
          disabled
          placeholder="예: ABC123"
          className="mt-1 w-full rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted disabled:opacity-70"
        />
      </div>

      <div className="mt-6 flex flex-col gap-2">
        <button
          type="button"
          disabled
          className="w-full cursor-not-allowed rounded-lg border border-accent-border bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg opacity-70"
        >
          학급 연결하고 시작
        </button>
        <button
          type="button"
          disabled
          className="w-full cursor-not-allowed rounded-lg px-4 py-2.5 text-sm font-medium text-fg-muted opacity-70"
        >
          학급 없이 시작
        </button>
      </div>
    </div>
  );
}
