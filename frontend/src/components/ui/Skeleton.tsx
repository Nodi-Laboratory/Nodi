// 08 D68/§4.3: 로딩(데이터 미도착) 표준 스켈레톤.
// "버튼 눌렀는데 빈 화면"을 없애기 위해 cold 진입 시 자리표시를 보여준다.
// pending(낙관)과 달리 accent를 쓰지 않는 회색 자리표시(시각 언어 구분, §4.1).
// 원형 노드·위→아래 트리·라벨 아래 디자인 일관성을 위해 그래프 자리표시는 원형으로 둔다.

/** 세션/파일 목록 자리표시(행 N개). */
export function SkeletonList({
  rows = 4,
  className = "",
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 ${className}`} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded-lg px-3 py-2"
        >
          <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded-full bg-fg/10" />
          <div
            className="h-3 animate-pulse rounded bg-fg/10"
            style={{ width: `${55 + ((i * 13) % 35)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

