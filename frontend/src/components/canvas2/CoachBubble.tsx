"use client";

/**
 * 질문 방향성 말풍선 (D194).
 *
 * 학생이 한 줄기를 이어 물어 왔을 때, **안 물어본 방향**을 카드 옆에서 귀띔한다.
 * 질문 문장은 주지 않는다 — 베낀 질문은 자기 질문이 아니라서, 이 기능이 풀려는
 * 문제("스스로 질문하기가 안 된다")를 하나도 안 푼다.
 *
 * ## 권유이지 강요가 아니다
 *
 * ×로 끌 수 있고, 끄면 입력창 위의 문구도 함께 사라진다(사용자 지시). 학생이
 * 닫은 뒤에도 계속 떠 있으면 그건 권유가 아니라 잔소리다.
 *
 * ## 왜 z-index가 높은가
 *
 * 카드 옆에 뜨는데 카드가 겹쳐 그려지면(선택된 카드는 z-index 12) 말풍선이
 * 그 밑에 깔린다 — 사용자 지시대로 **무엇보다 위**에 둔다.
 */

import { X } from "lucide-react";
import type { CoachAdvice } from "@/lib/api/coach";

/** 카드보다 확실히 위. 선택 카드가 12, 드래그가 11이다(TextItem). */
const BUBBLE_Z = 40;

/** 카드 오른쪽으로 띄우는 거리(월드 px). 붙여 놓으면 카드 테두리와 섞인다. */
const GAP = 18;

export interface CoachBubbleProps {
  advice: CoachAdvice;
  /** 붙을 카드의 월드 좌표와 폭. */
  x: number;
  y: number;
  width: number;
  onDismiss: () => void;
}

export function CoachBubble({ advice, x, y, width, onDismiss }: CoachBubbleProps) {
  return (
    <div
      data-coach-bubble
      className="absolute rounded-xl border px-3 py-2.5 shadow-lg"
      style={{
        left: x + width + GAP,
        top: y,
        width: 250,
        zIndex: BUBBLE_Z,
        // 캔버스 오버레이는 기본적으로 포인터를 흘린다 — 여기만 받는다.
        pointerEvents: "auto",
        background: "var(--c-raised)",
        borderColor: "var(--c-live)",
        color: "var(--c-ink)",
      }}
      role="status"
    >
      {/* 카드 쪽을 가리키는 꼬리. 없으면 어느 카드에 대한 말인지 안 보인다. */}
      <span
        aria-hidden
        className="absolute"
        style={{
          left: -7,
          top: 18,
          width: 12,
          height: 12,
          transform: "rotate(45deg)",
          background: "var(--c-raised)",
          borderLeft: "1px solid var(--c-live)",
          borderBottom: "1px solid var(--c-live)",
        }}
      />

      <button
        type="button"
        data-no-pan
        aria-label="질문 방향 안내 닫기"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="absolute right-1.5 top-1.5 rounded p-0.5 transition-colors hover:bg-[var(--c-sunk)]"
        style={{ color: "var(--c-ink-faint)" }}
      >
        <X size={13} />
      </button>

      {/* 두 줄을 그대로 — 서버가 만든 문구다(build_bubble). */}
      <p className="whitespace-pre-line pr-4 text-[12.5px] leading-relaxed">
        {advice.bubble}
      </p>
    </div>
  );
}
