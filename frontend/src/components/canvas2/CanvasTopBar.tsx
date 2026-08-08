"use client";

/**
 * 캔버스 좌상단 바 — 대화 목록 · 줌.
 *
 * v1의 `TopBar`를 대체한다. 도구는 우측 레일이 전부 가져갔으므로 여기는
 * **세션 전환**과 **화면 배율**만 남는다.
 *
 * "재배치" 버튼도 여기 있었다(D143). 사용자 지시 2026-08-08로 걷어냈다 —
 * D210 1단계가 `ReflowButton`을 없앤 것과 같은 이유다. 학생이 자리를 손으로
 * 정하는 캔버스에서 **자리를 통째로 흔드는 버튼**은 방해에 가깝다.
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

export function CanvasTopBar({
  title,
  zoom,
  onOpenSessions,
  onZoom,
  onFit,
}: Props) {
  return (
    <div data-no-pan className="ui absolute left-4 top-4 z-30 flex items-center gap-2">
      <button
        type="button"
        onClick={onOpenSessions}
        // 접근 이름이 세션 제목뿐이라 무엇을 하는 버튼인지 안 읽혔다.
        aria-label="대화 목록 열기"
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
          // 글자가 배율(42%)이라 **접근 이름이 "42%"가 된다** — 낭독기로는
          // 이 버튼이 무엇을 하는지 알 수 없다. 이름을 따로 준다.
          aria-label="전체 보기"
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
