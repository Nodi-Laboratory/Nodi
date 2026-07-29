"use client";

/**
 * 캔버스 좌상단 바 — 대화 목록 · 줌.
 *
 * v1의 `TopBar`를 대체한다. 도구는 우측 레일이 전부 가져갔으므로 여기는
 * **세션 전환**과 **화면 배율**만 남는다.
 *
 * 세션 전환이 없으면 학생이 지난 대화로 돌아갈 수 없다 — 캔버스를 새로
 * 만들면서 조용히 없애면 안 되는 기능이다.
 */

import { Maximize2, Menu, Minus, Plus } from "lucide-react";

interface Props {
  title: string;
  zoom: number;
  onOpenSessions: () => void;
  onZoom: (delta: number) => void;
  onFit: () => void;
}

export function CanvasTopBar({ title, zoom, onOpenSessions, onZoom, onFit }: Props) {
  return (
    <div data-no-pan className="ui absolute left-4 top-4 z-30 flex items-center gap-2">
      <button
        type="button"
        onClick={onOpenSessions}
        className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition-colors"
        style={{
          background: "var(--c-raised)",
          borderColor: "var(--c-rule)",
          color: "var(--c-ink)",
          boxShadow: "var(--c-shadow-sm)",
        }}
      >
        <Menu size={15} style={{ color: "var(--c-ink-soft)" }} />
        <span className="max-w-40 truncate">{title}</span>
      </button>

      <div
        className="flex items-center rounded-lg border"
        style={{
          background: "var(--c-raised)",
          borderColor: "var(--c-rule)",
          boxShadow: "var(--c-shadow-sm)",
        }}
      >
        <ZoomButton label="축소" onClick={() => onZoom(1 / 1.25)}>
          <Minus size={14} />
        </ZoomButton>
        <button
          type="button"
          onClick={onFit}
          title="전체 보기"
          className="label px-1.5 py-1.5 tabular-nums transition-colors hover:bg-[var(--c-sunk)]"
          style={{ color: "var(--c-ink-soft)", minWidth: 46 }}
        >
          {Math.round(zoom * 100)}%
        </button>
        <ZoomButton label="확대" onClick={() => onZoom(1.25)}>
          <Plus size={14} />
        </ZoomButton>
        <span className="my-1.5 w-px self-stretch" style={{ background: "var(--c-rule)" }} />
        <ZoomButton label="전체 보기" onClick={onFit}>
          <Maximize2 size={13} />
        </ZoomButton>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center transition-colors hover:bg-[var(--c-sunk)]"
      style={{ color: "var(--c-ink-soft)" }}
    >
      {children}
    </button>
  );
}
