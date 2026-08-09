"use client";

/**
 * 캔버스 상단 바 — **여기가 어디인지만 말한다** (사용자 지시 2026-08-09).
 *
 * 예전에는 이 자리에 [삼선 + 대화방 이름] 버튼과 [− 000% +] 줌 막대가 있었다.
 * 둘 다 걷어냈다:
 *
 *   · 삼선(대화 목록)  → 사이드바의 **기록**이 맡는다
 *   · 줌 막대          → 휠·Ctrl+휠로 하고, 미니맵에도 같은 버튼이 있다
 *
 * 비운 이유가 중요하다. 그 자리는 **미니맵이 붙을 수 있는 네 모서리 중
 * 하나**인데, 버튼 둘이 점유하고 있어서 좌상단만 쓸 수 없었다.
 *
 * 사이드바에서 학급 동그라미가 사라지면서 **지금 어느 학급의 어느 대화방인지**
 * 알 길이 없어졌다. 그것을 여기가 말한다. 누를 수 없다 — 알려 주는 것 외에
 * 아무 일도 하지 않는다(사용자 지시).
 */

interface Props {
  /** 학급 이름. 개인 세션이면 null. */
  spaceName: string | null;
  /** 대화방 이름. */
  sessionTitle: string;
}

export function CanvasTopBar({ spaceName, sessionTitle }: Props) {
  return (
    <div
      data-no-pan
      data-canvas-crumb
      /* 크롬 배율 (`lib/ui/scale.ts`). */
      style={{ zoom: "var(--ui-scale, 1)" }}
      className="ui pointer-events-none absolute left-4 top-4 z-30 flex items-center"
    >
      <span
        className="label max-w-[46ch] truncate rounded-lg border px-2.5 py-1.5 text-[13px]"
        style={{
          background: "var(--c-raised)",
          borderColor: "var(--c-rule)",
          color: "var(--c-ink-soft)",
          boxShadow: "var(--c-shadow-sm)",
        }}
      >
        {spaceName ? (
          <>
            <span style={{ color: "var(--c-ink)" }}>{spaceName}</span> 학급{" "}
            <span style={{ color: "var(--c-ink)" }}>{sessionTitle}</span> 대화방
          </>
        ) : (
          <>
            <span style={{ color: "var(--c-ink)" }}>개인</span> 세션{" "}
            <span style={{ color: "var(--c-ink)" }}>{sessionTitle}</span> 대화방
          </>
        )}
      </span>
    </div>
  );
}
