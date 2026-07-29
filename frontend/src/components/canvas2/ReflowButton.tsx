"use client";

/**
 * "위치 정리" 버튼 (사용자 지시).
 *
 * 본문을 고치거나 분류를 바꿔도 **위치는 자동으로 안 바뀐다** — 학생이 방금
 * 보고 있던 자리에서 글이 갑자기 사라지면 흐름이 끊긴다. 대신 이 버튼이 뜨고,
 * 누르면 그때 옮긴다.
 *
 * `×`가 붙어 있는 것도 지시다. 버튼이 계속 거슬리면 지울 수 있어야 한다.
 */

import { ArrowDownUp, X } from "lucide-react";

interface Props {
  onReflow: () => void;
  onDismiss: () => void;
}

export function ReflowButton({ onReflow, onDismiss }: Props) {
  return (
    <span
      data-no-pan
      className="ui inline-flex items-center overflow-hidden rounded-full border"
      style={{
        borderColor: "var(--c-rule)",
        background: "var(--c-raised)",
        boxShadow: "var(--c-shadow-sm)",
      }}
    >
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onReflow();
        }}
        className="flex items-center gap-1.5 py-1 pl-2.5 pr-2 text-[12px] transition-colors hover:bg-[var(--c-sunk)]"
        style={{ color: "var(--c-ink-soft)" }}
      >
        <ArrowDownUp size={12} />
        위치 정리
      </button>
      <span className="h-4 w-px" style={{ background: "var(--c-rule)" }} />
      <button
        type="button"
        aria-label="위치 정리 버튼 숨기기"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="px-1.5 py-1 transition-colors hover:bg-[var(--c-sunk)]"
        style={{ color: "var(--c-ink-faint)" }}
      >
        <X size={12} />
      </button>
    </span>
  );
}
