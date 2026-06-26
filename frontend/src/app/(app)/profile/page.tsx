/**
 * 프로필 설정 페이지.
 * Stage 0: UI 골격만 (동작 X). 이름 변경 입력 + 학급 추가 입력 자리.
 * 학급 추가는 온보딩과 동일한 공용 class-join 서비스 사용 (Stage 4 연동).
 */
export default function ProfilePage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <header>
        <h1 className="text-2xl font-bold text-fg">프로필 설정</h1>
        <p className="mt-1 text-sm text-fg-muted">
          이름과 가입 학급을 관리합니다. (Stage 4 연동)
        </p>
      </header>

      {/* 이름 변경 */}
      <section className="rounded-xl border border-accent-border/30 bg-bg-elevated p-5">
        <h2 className="text-sm font-semibold text-fg">이름 변경</h2>
        <p className="mt-1 text-xs text-fg-muted">
          표시 이름(display_name)을 수정합니다.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            disabled
            placeholder="표시 이름"
            className="flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted disabled:opacity-70"
          />
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-white opacity-70"
          >
            저장
          </button>
        </div>
      </section>

      {/* 학급 추가 */}
      <section className="rounded-xl border border-accent-border/30 bg-bg-elevated p-5">
        <h2 className="text-sm font-semibold text-fg">학급 추가</h2>
        <p className="mt-1 text-xs text-fg-muted">
          학급 코드를 입력해 새 학급에 연결합니다. (온보딩과 동일 메커니즘)
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            disabled
            placeholder="학급 코드"
            className="flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted disabled:opacity-70"
          />
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-lg border border-accent-border bg-accent px-4 py-2 text-sm font-medium text-accent-fg opacity-70"
          >
            연결
          </button>
        </div>
      </section>
    </div>
  );
}
