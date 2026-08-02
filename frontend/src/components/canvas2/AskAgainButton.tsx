"use client";

/**
 * "다시 질문하기" — **AI가 쓴 답에만** 붙는다 (D149, 사용자 지시 2026-08-02).
 *
 * 누르면 그 답이 인용된 채 입력창이 열린다. 학생은 "이 부분이 이해가 안
 * 돼요"처럼 이어서 물을 수 있고, 새 답은 그 글의 **자식**으로 붙어 선으로
 * 연결된다 — 어떤 답에서 갈라져 나온 이야기인지가 캔버스에 남는다.
 *
 * 전에는 같은 기능이 학생 글에 "AI에게 묻기"로 붙어 있었다. 학생이 방금 쓴
 * 메모를 AI에게 넘기는 흐름인데, 정작 물어볼 것이 생기는 자리는 **답을 읽고
 * 막힌 지점**이라 자리를 옮겼다.
 */

import { MessageCircleQuestion } from "lucide-react";

export function AskAgainButton({ onAsk }: { onAsk: () => void }) {
  return (
    <button
      type="button"
      data-no-pan
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onAsk();
      }}
      title="이 답에 이어서 물어봅니다"
      className="ui inline-flex items-center gap-1.5 rounded-full border py-1 pl-2.5 pr-3 text-[12px] font-medium transition-colors"
      style={{
        borderColor: "var(--c-live)",
        background: "var(--c-live-wash)",
        color: "var(--c-live)",
      }}
    >
      <MessageCircleQuestion size={12} />
      다시 질문하기
    </button>
  );
}
