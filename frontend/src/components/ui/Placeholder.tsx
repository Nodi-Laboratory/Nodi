import type { ReactNode } from "react";

/**
 * Stage 0 스켈레톤용 플레이스홀더 박스.
 * 실제 기능은 이후 단계에서 채운다. 라벨/안내만 표시.
 */
export function Placeholder({
  label,
  hint,
  className = "",
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col rounded-xl border border-dashed border-accent-border/60 bg-bg-elevated p-4 ${className}`}
    >
      <div className="text-sm font-semibold text-fg">{label}</div>
      {hint ? (
        <div className="mt-1 text-xs text-fg-muted">{hint}</div>
      ) : null}
      {children ? <div className="mt-3 flex-1">{children}</div> : null}
    </div>
  );
}
