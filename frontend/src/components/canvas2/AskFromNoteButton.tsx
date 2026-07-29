"use client";

/**
 * "AI에게 묻기" — 학생이 쓴 글에만 붙는다 (D126, 사용자 지시).
 *
 * 누르면 그 글이 질문으로 들어간 채 입력창이 열린다. 학생은 거기에 덧붙여
 * 물을 수 있고, 답은 그 글 **오른쪽**에 붙어 선으로 연결된다.
 *
 * `×`로 지울 수 있다 — 메모마다 버튼이 하나씩 떠 있으면 캔버스가 시끄럽다.
 */

import { Sparkles, X } from "lucide-react";

interface Props {
  onAsk: () => void;
  onDismiss: () => void;
}

export function AskFromNoteButton({ onAsk, onDismiss }: Props) {
  return (
    <span
      data-no-pan
      className="ui inline-flex items-center overflow-hidden rounded-full border"
      style={{
        borderColor: "var(--c-live)",
        background: "var(--c-live-wash)",
      }}
    >
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onAsk();
        }}
        className="flex items-center gap-1.5 py-1 pl-2.5 pr-2 text-[12px] font-medium transition-colors"
        style={{ color: "var(--c-live)" }}
      >
        <Sparkles size={12} />
        AI에게 묻기
      </button>
      <span className="h-4 w-px" style={{ background: "var(--c-live)", opacity: 0.3 }} />
      <button
        type="button"
        aria-label="이 버튼 숨기기"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="px-1.5 py-1 transition-colors"
        style={{ color: "var(--c-live)", opacity: 0.6 }}
      >
        <X size={12} />
      </button>
    </span>
  );
}
