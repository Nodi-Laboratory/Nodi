import { Placeholder } from "@/components/ui/Placeholder";

/**
 * 홈 페이지 (사이드바 홈 진입점).
 * Stage 0: 자리만 잡는다 — 개념 그래프 박스 / 대화 내역 / 질문 박스(가로 버튼 3개).
 * 총괄 AI(overseer)·실제 데이터는 Stage 4.
 */
export default function HomePage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-bold text-fg">홈</h1>
        <p className="mt-1 text-sm text-fg-muted">
          공간을 가로지르는 진입점. 많이 쓴 개념과 최근 대화를 한눈에.
        </p>
      </header>

      {/* 개념 그래프 박스 */}
      <Placeholder
        label="개념 그래프"
        hint="많이 쓴 개념을 중심으로 한 큰 노드 (Stage 4)"
        className="min-h-48"
      >
        <div className="flex h-40 items-center justify-center text-sm text-fg-muted">
          개념 그래프 박스 자리
        </div>
      </Placeholder>

      {/* 대화 내역 */}
      <Placeholder
        label="대화 내역"
        hint="최근 세션 목록 (Stage 4)"
        className="min-h-32"
      >
        <div className="flex h-24 items-center justify-center text-sm text-fg-muted">
          대화 내역 리스트 자리
        </div>
      </Placeholder>

      {/* 질문 박스 — 가로 버튼 3개 */}
      <section className="rounded-xl border border-dashed border-accent-border/60 bg-bg-elevated p-4">
        <div className="text-sm font-semibold text-fg">질문 박스</div>
        <div className="mt-1 text-xs text-fg-muted">
          질문에 맞는 루트를 정한 뒤 네비게이터로 질문 생성 (Stage 4)
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {["질문 후보 1", "질문 후보 2", "질문 후보 3"].map((q) => (
            <button
              key={q}
              type="button"
              disabled
              className="cursor-not-allowed rounded-lg border border-accent-border bg-accent px-3 py-2 text-sm font-medium text-accent-fg opacity-70"
            >
              {q}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
