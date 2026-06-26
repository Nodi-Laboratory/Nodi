/**
 * 공간 워크스페이스 — 3분할 스켈레톤.
 * [대화기록 사이드바 | 대화 패널 | 세션 그래프 뷰]
 * Stage 0: 빈 플레이스홀더(라벨만). 채팅 SSE는 Stage 1, D3 그래프는 Stage 1.
 */
export default async function SpaceWorkspacePage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;

  return (
    <div className="flex h-full w-full flex-col">
      <header className="border-b border-accent-border/30 bg-bg-elevated px-5 py-3">
        <h1 className="text-sm font-semibold text-fg">
          공간 워크스페이스
          <span className="ml-2 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg">
            {spaceId}
          </span>
        </h1>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_360px]">
        {/* 1) 대화기록 사이드바 */}
        <aside className="min-h-0 overflow-auto border-r border-accent-border/30 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            대화기록
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="rounded-lg border border-dashed border-accent-border/50 bg-bg-elevated px-3 py-2 text-sm text-fg-muted"
              >
                세션 {n} (Stage 1)
              </div>
            ))}
          </div>
        </aside>

        {/* 2) 대화 패널 */}
        <section className="flex min-h-0 flex-col">
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="text-center text-sm text-fg-muted">
              대화 패널 — Gemini SSE 스트리밍 (Stage 1)
            </div>
          </div>
          <div className="border-t border-accent-border/30 p-4">
            <div className="flex items-center gap-2 rounded-xl border border-accent-border/50 bg-bg-elevated px-3 py-2">
              <div className="flex-1 text-sm text-fg-muted">
                질문 입력 자리 (Stage 1)
              </div>
              <button
                type="button"
                disabled
                className="cursor-not-allowed rounded-lg bg-accent-deep px-3 py-1.5 text-sm font-medium text-white opacity-70"
              >
                전송
              </button>
            </div>
          </div>
        </section>

        {/* 3) 세션 그래프 뷰 */}
        <aside className="min-h-0 border-l border-accent-border/30 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            세션 그래프
          </div>
          <div className="mt-3 flex h-[calc(100%-2rem)] items-center justify-center rounded-xl border border-dashed border-accent-border/50 bg-bg-elevated text-center text-sm text-fg-muted">
            세션 그래프 (Stage 1)
            <br />
            D3 수직 트리 · 노란 노드
          </div>
        </aside>
      </div>
    </div>
  );
}
