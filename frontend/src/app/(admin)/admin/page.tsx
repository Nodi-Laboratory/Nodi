/**
 * 관리자 운영 콘솔 스텁 (다크 운영 톤).
 * 권한 · 런타임 설정 · 사용량 · 로그 · 작업 모니터는 Stage 4.
 */
export default function AdminPage() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-[#23201a] p-8">
      <div className="max-w-md rounded-2xl border border-dashed border-white/15 bg-[#2c2820] p-8 text-center">
        <h1 className="text-lg font-bold text-white">운영 콘솔</h1>
        <p className="mt-2 text-sm text-white/60">
          권한 · 런타임 설정 · 사용량 · 로그 · 작업 모니터 (Stage 4)
        </p>
      </div>
    </div>
  );
}
