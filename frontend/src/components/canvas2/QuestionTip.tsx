"use client";

/**
 * 이 답을 부른 질문을 글 위에 띄운다 (사용자 지시).
 *
 * 캔버스에 답만 남으면 시간이 지나 "이게 뭘 물어본 거였지"가 된다. 질문 자체는
 * 별도 아이템으로도 캔버스에 있지만, 학생이 답을 멀리 끌어다 놓으면 둘이
 * 떨어져서 눈으로 잇기 어렵다.
 *
 * **기본은 한 줄이다.** 질문이 길면 뒤를 자르고 `…`로 끝낸다. 여러 줄로 펼치면
 * 정작 읽으려던 답을 가린다. 누르면 그 자리에서 원문 전체로 펼쳐지고, 다시
 * 누르면 접힌다.
 */

import { useState } from "react";
import { Quote } from "lucide-react";

interface Props {
  text: string;
}

export function QuestionTip({ text }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <button
      type="button"
      data-no-pan
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      title={open ? "접기" : "질문 전체 보기"}
      aria-expanded={open}
      className="absolute flex items-start gap-1.5 rounded-lg px-2 py-1 text-left text-[12px] transition-colors"
      style={{
        // 글의 윗변 바깥. 왼쪽 괘선(-16px)에 맞춰 세로선을 하나로 읽히게 한다.
        left: -16,
        bottom: "calc(100% + 14px)",
        maxWidth: open ? 380 : "min(100%, 340px)",
        background: "var(--c-raised)",
        border: "1px solid var(--c-rule)",
        color: "var(--c-ink-soft)",
        boxShadow: "var(--c-shadow-sm)",
        // 접힌 상태에서 폭이 내용만큼만 되도록. 펼치면 최대폭까지 쓴다.
        width: "max-content",
      }}
    >
      <Quote size={11} style={{ color: "var(--c-hand)", marginTop: 3, flexShrink: 0 }} />
      <span
        style={
          open
            ? { whiteSpace: "pre-wrap", lineHeight: 1.6 }
            : // 한 줄 고정 — 넘치면 뒤를 자른다.
              { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }
        }
      >
        {text}
      </span>
    </button>
  );
}
