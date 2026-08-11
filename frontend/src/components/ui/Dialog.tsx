"use client";

/**
 * 앱 공통 모달 (사용자 지시 2026-08-10).
 *
 * 설정·도움말이 **페이지에서 팝업으로** 바뀌면서 생겼다. 페이지였을 때는
 * 도움말을 보려면 하던 것을 떠나야 했다 — 캔버스에서 "이거 어떻게 쓰지?"가
 * 생겼을 때 화면이 통째로 바뀌면, 돌아왔을 때 다시 그 상황을 만들어야 한다.
 *
 * ## ⚠️ 몸통(body)에 붙인다
 *
 * 사이드바에는 `zoom: var(--ui-scale)`이 걸려 있다. `zoom`은 **자손의
 * `position: fixed` 기준까지 바꾼다** — 사이드바 안에서 그리면 팝업이
 * 64px짜리 기둥 안에 배율까지 먹은 채로 뜬다. 포털로 몸통에 내보내면
 * 그 문제가 성립하지 않는다.
 *
 * ## 여는 동안 뒤는 안 구른다
 *
 * 배경이 스크롤되면 팝업이 화면 위에 떠 있는 종이가 아니라 페이지의 일부처럼
 * 보인다. 닫을 때 되돌리는 값은 **열 때의 값**이지 빈 문자열이 아니다 —
 * 다른 곳에서 이미 잠가 뒀을 수 있다.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { pushModal } from "@/lib/ui/modalLayer";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** 스크린리더가 읽을 이름. 제목 글자와 같은 말을 쓴다. */
  label: string;
  /** 헤더에 그릴 것 — 없으면 헤더 줄 자체가 없다(도움말처럼 그림이 꽉 찬 팝업). */
  header?: ReactNode;
  /** 상자 최대 폭(Tailwind 클래스). */
  width?: string;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  label,
  header,
  width = "max-w-xl",
  children,
}: DialogProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // 뒤쪽 화면이 키를 못 먹게 한다(`lib/ui/modalLayer.ts`의 이유를 볼 것).
    const release = pushModal();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // 캡처로 받는다 — 캔버스가 document에서 같은 키를 듣고 있어서(도구 해제),
    // 버블에 걸면 팝업이 닫히기 전에 그쪽이 먼저 반응한다.
    document.addEventListener("keydown", onKey, { capture: true });
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      release();
      document.removeEventListener("keydown", onKey, { capture: true });
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // 열리면 상자로 포커스를 옮긴다 — 안 그러면 Tab이 뒤쪽 화면을 돌아다닌다.
  useEffect(() => {
    if (open) boxRef.current?.focus();
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      style={{ background: "rgba(28, 30, 24, 0.38)" }}
      onClick={onClose}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        /**
         * **윤곽선을 걷어냈다** (사용자 지시 2026-08-11). 연두 테두리가 팝업
         * 마다 둘려 있었다 — 떠 있는 것은 그림자로만 뜬다(요구사항 §8).
         *
         * 이 한 줄이 설정·도움말·최근 대화·학급 추가·방 목록을 **전부** 바꾼다.
         * 팝업마다 제 테두리를 갖고 있으면 다음 팝업에서 또 어긋난다.
         */
        className={`flex max-h-[88vh] w-full ${width} flex-col overflow-hidden rounded-2xl bg-bg-elevated outline-none`}
        style={{ boxShadow: "0 18px 50px rgba(23,23,18,.14), 0 2px 8px rgba(23,23,18,.06)" }}
      >
        {/**
         * 구분선은 **양 끝이 변에 안 닿는다** (사용자 지시 2026-08-11).
         *
         * `border-b`는 상자 폭을 꽉 채워 팝업을 위아래 두 칸으로 자른다. 안쪽
         * 으로 물린 선은 "여기서 나뉜다"만 말하고 상자를 안 쪼갠다. 그래서
         * 테두리가 아니라 **가짜 요소**로 그린다.
         */}
        {header !== undefined && (
          <header className="relative flex shrink-0 items-start justify-between gap-4 px-7 py-5 after:absolute after:inset-x-7 after:bottom-0 after:h-px after:bg-[var(--line)] after:content-['']">
            <div className="min-w-0">{header}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="닫기"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-accent-soft hover:text-fg"
            >
              <X size={18} />
            </button>
          </header>
        )}
        {/**
         * **좌우 여백은 여기서 한 번에 준다** (사용자 지시 2026-08-11:
         * "너무 좁아 보임").
         *
         * 팝업마다 제 패딩을 갖고 있어서 최근 대화는 넉넉하고 학급 추가는
         * 빠듯한 식으로 갈렸다. 헤더(px-7)와 같은 값을 몸통에도 물려 두면
         * 글이 상자 변에 붙지 않는다.
         */}
        <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6 pt-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
