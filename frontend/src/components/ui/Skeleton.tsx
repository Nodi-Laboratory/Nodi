// 08 D68/§4.3: 로딩(데이터 미도착) 표준 스켈레톤.
// "버튼 눌렀는데 빈 화면"을 없애기 위해 cold 진입 시 자리표시를 보여준다.
// pending(낙관)과 달리 accent를 쓰지 않는 회색 자리표시(시각 언어 구분, §4.1).
// 원형 노드·위→아래 트리·라벨 아래 디자인 일관성을 위해 그래프 자리표시는 원형으로 둔다.

/** 단일 회색 바(텍스트/행 자리). */
export function SkeletonBar({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-fg/10 ${className}`}
      aria-hidden
    />
  );
}

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

/**
 * 그래프 패널 자리표시: 원형 노드 + 아래 라벨 바 + 연결선 느낌의 점.
 * nodi 디자인(원형·위→아래)을 흐릿하게 암시해 cold 진입 체감지연을 줄인다.
 */
export function SkeletonGraph({ className = "" }: { className?: string }) {
  const nodes = [
    { cx: 50, cy: 18 },
    { cx: 32, cy: 48 },
    { cx: 68, cy: 48 },
    { cx: 50, cy: 78 },
  ];
  return (
    <div
      className={`flex h-full w-full items-center justify-center ${className}`}
      aria-hidden
    >
      <svg
        viewBox="0 0 100 100"
        className="h-3/4 w-3/4 animate-pulse opacity-60"
        preserveAspectRatio="xMidYMid meet"
      >
        <line x1="50" y1="18" x2="32" y2="48" stroke="currentColor" strokeWidth="0.8" className="text-fg/10" />
        <line x1="50" y1="18" x2="68" y2="48" stroke="currentColor" strokeWidth="0.8" className="text-fg/10" />
        <line x1="32" y1="48" x2="50" y2="78" stroke="currentColor" strokeWidth="0.8" className="text-fg/10" />
        {nodes.map((n, i) => (
          <g key={i}>
            <circle cx={n.cx} cy={n.cy} r="4.5" className="fill-fg/10" />
            <rect
              x={n.cx - 6}
              y={n.cy + 6}
              width="12"
              height="2.4"
              rx="1.2"
              className="fill-fg/10"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
