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
 * ## 캔버스 **위에 떠 있다** (사용자 지시 2026-08-10)
 *
 * 한동안 이 바는 한 줄을 차지했다(D218). 미니맵이 위 모서리에 붙을 자리를
 * 내주려던 것인데, 그 대가로 바 뒤가 **페이지 배경**이 되어 캔버스가 그 높이만큼
 * 잘려 보였다 — 연두색 띠가 화면을 가로지르는 모습이다.
 *
 * 이제 캔버스가 화면 끝까지 오고 바는 그 위에 뜬다. 배경도 없앴다: 이 바가
 * 하는 일은 **알려 주는 것**뿐이라 자기 판을 가질 이유가 없다.
 *
 * ⚠️ 그래서 위 두 모서리는 다시 바에 가린다. 미니맵이 그리로 붙을 때
 * **바 높이만큼 내려 앉도록** `cornerPos`에 위 여백을 넘긴다 — 자리를 비켜
 * 주는 일을 레이아웃이 아니라 계산이 맡는다.
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
      className="ui pointer-events-none absolute inset-x-0 top-0 z-20 px-4 pt-3"
    >
      {/**
        * **판이 없다** (사용자 지시 2026-08-10: "배경에 캔버스 화면이 보이도록").
        *
        * 연한 연두를 깔아 뒀는데, 캔버스가 그 아래에서 시작하다 보니 색을 뺀
        * 자리가 종이가 아니라 페이지 배경이었다 — 화면을 가로지르는 띠로 보였다.
        * 캔버스를 위까지 올리고 색을 뺐다. 글자는 종이 위에 바로 앉는다.
        */}
      <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5">
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
