/**
 * 교사 컨트롤 패널 스텁 (대화 공간 없음).
 * 자료실 업로드/임베딩 · 학생 대화 열람은 Stage 4.
 */
export default function TeacherPage() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-bg p-8">
      <div className="max-w-md rounded-2xl border border-dashed border-accent-border/60 bg-bg-elevated p-8 text-center">
        <h1 className="text-lg font-bold text-fg">교사 컨트롤 패널</h1>
        <p className="mt-2 text-sm text-fg-muted">
          학급 자료실 · 학생 대화 열람 (Stage 4)
        </p>
      </div>
    </div>
  );
}
