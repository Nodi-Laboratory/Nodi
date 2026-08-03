"use client";

/**
 * 트리를 걸어 다니는 방향 버튼 (D157).
 *
 * ```
 *              ┌──────────────┐        ↑  같은 트리의 부모
 *              │      ↑       │
 *   ┌─┐        └──────────────┘   ┌─┐
 *   │←│                           │→│  ←/→  왼쪽·오른쪽 트리(태그 열)
 *   └─┘                           └─┘
 *              ┌ 입력창 ──────┐
 *              └──────────────┘
 *              ┌──────────────┐        ↓  자식으로. 갈래가 여럿이면
 *              │  ↓  │  ↓  │ ↓│           **버튼이 갈래 수만큼 쪼개진다**
 *              └──────────────┘
 * ```
 *
 * 모양은 방향을 말한다 — 상하는 가로로 길고 좌우는 세로로 길다(사용자 지시
 * 2026-08-02). 눌러야 할 곳이 이동할 방향과 같은 축에 있어야 손이 헷갈리지
 * 않는다.
 *
 * 갈 곳이 없는 방향은 **숨기지 않고 흐리게** 둔다. 사라지면 남은 버튼들이
 * 자리를 옮겨, 누르려던 곳에 다른 버튼이 와 있게 된다.
 */

import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";

export interface NavBranch {
  id: string;
  /** 버튼에 쓸 짧은 이름. 갈래가 여럿일 때만 보인다. */
  label: string;
}

interface Props {
  canUp: boolean;
  canLeft: boolean;
  canRight: boolean;
  /** 자식 갈래. 0이면 아래로 갈 곳이 없고, 2 이상이면 버튼이 쪼개진다. */
  branches: NavBranch[];
  onGo: (dir: "up" | "left" | "right") => void;
  onGoBranch: (id: string) => void;
}

/**
 * 막대의 바탕. **진하게** 간다 (사용자 지시 2026-08-03: "좌우상하 이동
 * 버튼을 더 진하게").
 *
 * 캔버스 위에 떠 있는 조작 장치라 종이색에 가까우면 배경에 묻힌다 — 특히
 * 좌우 막대는 폭이 28px뿐이라 테두리만으로는 눈에 안 들어온다.
 */
const BAR = {
  background: "var(--c-ink)",
  borderColor: "var(--c-ink)",
  boxShadow: "var(--c-shadow-lg)",
} as const;
/** 진한 바탕 위의 글자·기호 색. */
const ON_BAR = "var(--c-paper)";

export function TreeNav({ canUp, canLeft, canRight, branches, onGo, onGoBranch }: Props) {
  return (
    <>
      {/* 위 — 가로로 긴 막대. 상단바(왼쪽)와 지도(오른쪽) 사이 가운데. */}
      <button
        type="button"
        data-no-pan
        disabled={!canUp}
        onClick={() => onGo("up")}
        aria-label="이전 노드 (위 화살표)"
        title="이전 노드 — ↑"
        className="ui absolute left-1/2 top-4 z-30 flex h-7 w-[168px] -translate-x-1/2 items-center justify-center rounded-lg border transition-opacity disabled:opacity-30"
        style={{ ...BAR, color: ON_BAR }}
      >
        <ChevronUp size={16} />
      </button>

      {/* 왼쪽·오른쪽 — 세로로 긴 막대. 화면 가운데 높이. */}
      <button
        type="button"
        data-no-pan
        disabled={!canLeft}
        onClick={() => onGo("left")}
        aria-label="왼쪽 트리 (왼쪽 화살표)"
        title="왼쪽 트리 — ←"
        className="ui absolute left-4 top-1/2 z-30 flex h-[104px] w-7 -translate-y-1/2 items-center justify-center rounded-lg border transition-opacity disabled:opacity-30"
        style={{ ...BAR, color: ON_BAR }}
      >
        <ChevronLeft size={16} />
      </button>
      <button
        type="button"
        data-no-pan
        disabled={!canRight}
        onClick={() => onGo("right")}
        aria-label="오른쪽 트리 (오른쪽 화살표)"
        title="오른쪽 트리 — →"
        className="ui absolute right-4 top-1/2 z-30 flex h-[104px] w-7 -translate-y-1/2 items-center justify-center rounded-lg border transition-opacity disabled:opacity-30"
        style={{ ...BAR, color: ON_BAR }}
      >
        <ChevronRight size={16} />
      </button>

      {/**
       * 아래 — **입력창 아래**(사용자 지시). 갈래가 여럿이면 그 수만큼 쪼갠다.
       *
       * 갈래마다 이름을 적는다. 화살표만 셋 놓으면 어느 쪽이 무엇인지 알 수
       * 없어서, 고르는 것이 아니라 찍는 것이 된다.
       */}
      <div
        data-no-pan
        className="ui absolute bottom-3 left-1/2 z-30 flex h-7 w-[min(680px,calc(100%-140px))] -translate-x-1/2 overflow-hidden rounded-lg border"
        style={BAR}
      >
        {branches.length === 0 ? (
          <button
            type="button"
            disabled
            aria-label="다음 노드 (아래 화살표)"
            className="flex flex-1 items-center justify-center opacity-30"
            style={{ color: ON_BAR }}
          >
            <ChevronDown size={16} />
          </button>
        ) : (
          branches.map((b, i) => (
            <button
              key={b.id}
              type="button"
              onClick={() => onGoBranch(b.id)}
              aria-label={
                branches.length > 1 ? `${b.label} 갈래로 이동` : "다음 노드 (아래 화살표)"
              }
              title={branches.length > 1 ? b.label : "다음 노드 — ↓"}
              className="flex min-w-0 flex-1 items-center justify-center gap-1 px-2 transition-colors hover:bg-[var(--c-on-dark)]"
              style={{
                color: ON_BAR,
                // 갈래 사이에 칸막이. 첫 칸 앞에는 두지 않는다.
                borderLeft: i > 0 ? "1px solid var(--c-on-dark)" : undefined,
              }}
            >
              <ChevronDown size={15} className="shrink-0" />
              {branches.length > 1 && (
                <span className="label truncate" style={{ letterSpacing: 0 }}>
                  {b.label}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </>
  );
}
