"use client";

/**
 * 캔버스 상단 바 — **여기가 어디인지 말하고, 기록을 연다**
 * (사용자 지시 2026-08-09).
 *
 * ## 왜 이 자리에 생겼나
 *
 * 사이드바에서 학급 동그라미를 걷어내면서(D217) **지금 어느 학급의 어느
 * 대화방인지** 알 길이 없어졌다. 그것을 여기가 말한다.
 *
 * ## 삼선이 여기로 왔다
 *
 * 지난 대화 서랍을 여는 버튼이 잠깐 사이드바에 있었는데, 캔버스 위쪽으로
 * 되돌렸다(사용자 지시) — 대화방을 오가는 일은 **캔버스 안에서 하는 일**이고,
 * 사이드바는 화면을 통째로 바꾸는 것들만 두는 편이 갈래가 분명하다.
 *
 * ## 떠 있지 않고 **자리를 차지한다**
 *
 * 예전 좌상단 버튼들은 캔버스 위에 떠 있었다(absolute). 그래서 미니맵이 그
 * 모서리에 못 붙었다(D211 9). 이 바는 캔버스 **위쪽에 한 줄로 자리를 잡아**
 * 그 문제가 성립하지 않는다 — 네 모서리는 전부 캔버스 것이다.
 */

import { Menu } from "lucide-react";

interface Props {
  /** 학급 이름. 개인 세션이면 null. */
  spaceName: string | null;
  /** 대화방 이름. */
  sessionTitle: string;
  /** 지난 대화 서랍이 열려 있나. */
  historyOpen: boolean;
  onToggleHistory: () => void;
}

export function CanvasTopBar({
  spaceName,
  sessionTitle,
  historyOpen,
  onToggleHistory,
}: Props) {
  return (
    <div
      data-no-pan
      data-canvas-crumb
      /* 크롬 배율 (`lib/ui/scale.ts`). */
      style={{ zoom: "var(--ui-scale, 1)" }}
      /**
       * ⚠️ **바는 포인터를 안 먹는다.** 알려 주는 것 말고 하는 일이 없는데,
       * 넓은 띠가 히트 영역을 가지면 그 아래 것을 가로챈다 — 실측 2026-08-09:
       * 도구 레일의 접기 버튼이 이 띠에 먹혀 눌리지 않았다(레일은 `zoom`이
       * 걸려 있어 자식 좌표가 띠 높이 안으로 들어온다).
       *
       * 눌러야 하는 것은 삼선 하나뿐이라 그것만 되돌린다.
       */
      className="ui pointer-events-none shrink-0 px-4 pt-3"
    >
      <div
        className="flex items-center gap-3 rounded-2xl px-4 py-2.5"
        /**
         * 색은 **연한 연두**다(사용자 지시: 예시 이미지보다 연하게). 진한
         * 띠는 캔버스 종이와 다투고, 이 바가 하는 일은 알려 주는 것뿐이라
         * 무게를 가질 이유가 없다.
         */
        style={{ background: "var(--accent-soft)" }}
      >
        <button
          type="button"
          onClick={onToggleHistory}
          aria-label="지난 대화"
          aria-pressed={historyOpen}
          title="지난 대화"
          className="pointer-events-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors"
          style={{
            borderColor: "var(--accent-border)",
            background: historyOpen ? "var(--accent)" : "transparent",
            color: "var(--fg)",
          }}
        >
          <Menu size={16} />
        </button>

        <span className="truncate text-[15px] font-semibold" style={{ color: "var(--fg)" }}>
          {spaceName ? `${spaceName} 학급` : "개인 세션"}
          <span className="mx-1.5 opacity-40">·</span>
          <span style={{ fontWeight: 500 }}>{sessionTitle}</span>
          <span className="opacity-60"> 대화방</span>
        </span>
      </div>
    </div>
  );
}
