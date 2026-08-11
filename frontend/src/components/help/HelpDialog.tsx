"use client";

/**
 * 도움말 — **넘겨 보는 팝업** (사용자 지시 2026-08-10).
 *
 * 페이지였을 때는 글만 줄줄이 있었다. 학생이 "이거 어떻게 쓰지?"를 느끼는
 * 자리는 캔버스 한복판인데, 거기서 화면을 통째로 바꿔 글을 읽히고 돌려보내는
 * 것은 도움이 아니라 방해다.
 *
 * 카드 한 장 = **기능 하나**다. 위는 움직이는 그림, 아래는 두어 줄. 좌우
 * 화살표로 넘긴다 — 목차를 훑는 것보다 넘기는 편이 "다음에 뭐가 있나"를
 * 계속 궁금하게 만든다.
 *
 * ## 지금 카드만 그린다
 *
 * 여섯 장면이 동시에 돌면 그만큼 낭비이고, 넘겨 왔을 때 애니메이션이 중간부터
 * 보인다. 활성 카드만 마운트해 **언제나 처음부터** 보이게 한다.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { HELP_SCENES, HelpSceneStyles } from "./HelpScenes";

export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  /**
   * 몸통을 **따로 둔다** — 닫히면 `Dialog`가 자식을 아예 안 그리므로 이 안의
   * 상태(몇 번째 카드인가)가 저절로 사라진다. 그래서 열 때마다 처음부터다.
   *
   * 이펙트로 0으로 되돌리는 길도 있었지만 그건 렌더를 한 번 더 부르는 일이고
   * React Compiler도 막는다 — **살아 있을 이유가 없는 상태는 마운트로 지운다.**
   */
  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="도움말"
      width="max-w-2xl"
      header={
        <>
          <h2 className="text-[19px] font-bold text-fg">도움말</h2>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            주요 기능을 화살표로 넘겨 보세요
          </p>
        </>
      }
    >
      <HelpBody />
    </Dialog>
  );
}

function HelpBody() {
  const [i, setI] = useState(0);
  const last = HELP_SCENES.length - 1;

  const go = useCallback(
    (d: number) => setI((v) => Math.min(last, Math.max(0, v + d))),
    [last],
  );

  // 좌우 방향키로도 넘긴다. 팝업이 포커스를 갖고 있으므로 캔버스 단축키와
  // 부딪히지 않는다(`Dialog`가 열릴 때 상자로 포커스를 옮긴다).
  /**
   * 몸통은 팝업이 열려 있을 때만 산다 — 그래서 `open`을 볼 필요가 없다.
   *
   * ⚠️ **창(window)에서 캡처로** 듣는다. 캔버스가 document에 캡처로 붙어
   * 방향키를 `stopPropagation`까지 하기 때문에, document에 걸면 이 핸들러에는
   * 아무것도 안 온다(실측 2026-08-10: 화살표가 한 번도 안 먹었다). 창은
   * document보다 위라 캡처 순서에서 먼저다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      e.stopPropagation();
      go(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [go]);

  const card = HELP_SCENES[i];
  const Scene = card.Scene;

  return (
    <>
      <HelpSceneStyles />

      <div className="flex min-h-0 flex-1 items-stretch">
        {/* ← */}
        <NavArrow side="left" disabled={i === 0} onClick={() => go(-1)} />

        <div className="flex min-w-0 flex-1 flex-col gap-4 px-2 py-5">
          {/**
           * 그림 — 높이를 못 박는다. 장면마다 내용이 달라 자연 높이에 맡기면
           * 넘길 때마다 팝업이 들썩인다.
           */}
          <div
            key={card.key}
            className="mx-auto w-full max-w-[440px] overflow-hidden rounded-2xl"
            style={{ height: 208 }}
          >
            <Scene />
          </div>

          <div className="px-3 text-center">
            <h3 className="text-[17px] font-bold text-fg">{card.title}</h3>
            {card.lines.map((line) => (
              <p key={line} className="mx-auto mt-2 max-w-[520px] text-[13.5px] leading-relaxed text-fg-muted">
                {line}
              </p>
            ))}
          </div>
        </div>

        {/* → */}
        <NavArrow side="right" disabled={i === last} onClick={() => go(1)} />
      </div>

      {/* 점 — 몇 장인지, 지금 어디인지. 눌러서 바로 갈 수도 있다. */}
      <footer className="relative flex shrink-0 items-center justify-center gap-2 py-4 before:absolute before:inset-x-2 before:top-0 before:h-px before:bg-[var(--line)] before:content-['']">
        {HELP_SCENES.map((s, n) => (
          <button
            key={s.key}
            type="button"
            aria-label={`${n + 1}번째 설명: ${s.title}`}
            aria-current={n === i}
            onClick={() => setI(n)}
            className="rounded-full transition-all"
            style={{
              width: n === i ? 20 : 7,
              height: 7,
              background: n === i ? "var(--accent-deep)" : "var(--accent-border)",
            }}
          />
        ))}
      </footer>
    </>
  );
}

function NavArrow({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === "left" ? "이전 설명" : "다음 설명"}
      className="flex w-12 shrink-0 items-center justify-center text-fg-muted transition-colors hover:bg-accent-soft/40 hover:text-fg disabled:pointer-events-none disabled:opacity-25"
    >
      {side === "left" ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
    </button>
  );
}
