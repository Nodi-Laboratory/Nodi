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
      <div className="flex items-center gap-3 px-1 py-1">
        {/**
         * **지난 대화 pill** (UI 개편 2026-08-11).
         *
         * 테두리 두른 원이었다. 참조 시안은 **둥근 흰 배경 + 그림자 + 라임
         * 포인트**의 작은 알약이라 그쪽으로 옮긴다 — 개편의 한 줄이 "라임
         * 테두리로 둘러싼 상자를 없앤다"이고 이 원이 그중 하나였다.
         *
         * 글자를 함께 둔다. 삼선 하나만으로는 무엇이 열리는지 눌러 봐야 알았다.
         */}
        {/**
         * **소속과 방 이름을 알약 안에 넣는다** (사용자 지시 2026-08-11,
         * 참조 이미지 3).
         *
         * 알약(삼선)과 글자가 따로 떠 있었다 — 캔버스 위에 뜬 것이 둘이라
         * 시선이 두 번 간다. 하나로 합치면 "지금 어디인지"가 한 덩어리로
         * 읽히고, 누르면 지난 대화가 열린다는 것도 그 덩어리에 붙는다.
         *
         * ⚠️ "학급"이라는 **단위 낱말을 뺐다.** "테스트 학급 학급"처럼 겹쳐
         * 나오던 자리다 — 학급 이름에 이미 그 말이 들어 있는 경우가 흔하다.
         */}
        <button
          type="button"
          onClick={onToggleHistory}
          aria-label="지난 대화"
          aria-pressed={historyOpen}
          className="pointer-events-auto flex max-w-[min(60vw,420px)] shrink-0 items-center gap-3 rounded-full py-2.5 pl-3 pr-6 text-left transition-colors"
          style={{
            background: historyOpen ? "var(--accent-soft)" : "#ffffff",
            boxShadow: "var(--shadow-float)",
          }}
        >
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{ background: "var(--accent-soft)", color: "var(--accent-deep)" }}
            aria-hidden
          >
            <Menu size={17} />
          </span>

          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[11px]" style={{ color: "var(--fg-muted)" }}>
              {spaceName ?? "개인 세션"}
            </span>
            <span className="truncate text-[16px] font-bold" style={{ color: "var(--fg)" }}>
              {sessionTitle}
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}
