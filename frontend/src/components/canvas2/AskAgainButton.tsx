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

import { CornerDownRight, MessageCircleQuestion } from "lucide-react";

/**
 * `picked`면 이미 이 노드에서 이어 묻는 중이다 (D151). 버튼이 **상태 표시로
 * 바뀐다** — 누를 것이 아니라 "여기에 붙습니다"를 알리는 자리가 된다.
 */
export function AskAgainButton({
  onAsk,
  picked,
}: {
  onAsk: () => void;
  picked: boolean;
}) {
  return (
    <button
      type="button"
      data-no-pan
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onAsk();
      }}
      title={picked ? "다음 답이 이 아래에 붙습니다" : "이 답에 이어서 물어봅니다"}
      className="ui inline-flex items-center gap-1.5 rounded-full border py-1 pl-2.5 pr-3 text-[12px] font-medium transition-colors"
      style={{
        borderColor: "var(--c-live)",
        background: picked ? "var(--c-live)" : "var(--c-live-wash)",
        color: picked ? "var(--c-paper)" : "var(--c-live)",
      }}
    >
      {picked ? <CornerDownRight size={12} /> : <MessageCircleQuestion size={12} />}
      {picked ? "여기에 이어서" : "다시 질문하기"}
    </button>
  );
}
