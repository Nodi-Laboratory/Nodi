/**
 * 개념 노드 페이지 — 세션 그래프와 분리된 별도 라우트.
 * "나무 상단(수관/잎)" 디자인 (force-graph 아님).
 * Stage 0: 안내만. 실제 비주얼은 Stage 2(열린 질문 B 시안 확인 후).
 */
export default function ConceptsPage() {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="max-w-md rounded-2xl border border-dashed border-accent-border/60 bg-bg-elevated p-8 text-center">
        <h1 className="text-lg font-bold text-fg">개념 나무 페이지</h1>
        <p className="mt-2 text-sm text-fg-muted">
          공간의 개념 태그를 모아 &quot;나무 수관&quot; 형태로 보여줍니다.
          <br />
          (Stage 2)
        </p>
      </div>
    </div>
  );
}
