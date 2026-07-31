"use client";

/**
 * 인출 연습 — "안 보고 다시 말해보기" (D138).
 *
 * ## 왜 이게 있어야 하나
 *
 * 캔버스로 바꾼 것만으로는 학습이 좋아지지 않는다. 근거가 지지하는 것은 공간
 * 배치가 아니라 **학습자가 직접 꺼내 보는 행위**다.
 *
 *   Karpicke & Blunt 2011 (Science 331:772)
 *     인출 연습 > 개념도 작성. 게다가 사후 검사를 개념도 형식으로 내도 인출이
 *     이겼다. **학생들의 예상은 정반대였다** — 체감으로는 판단할 수 없다.
 *   Adesope, Trevisan & Sundararajan 2017 (RER, 188개 실험)
 *     재학습 대비 g=.51(같은 학습 시간이면 .61).
 *   Chi & Wylie 2014 (ICAP)
 *     읽기는 Passive. 자기 말로 산출해야 Constructive로 올라간다.
 *     드래그·태그 변경은 Active일 뿐 등급을 올리지 않는다.
 *   Bastani et al. 2025 (PNAS 122)
 *     가드레일 없이 답을 그냥 주는 AI로 공부한 고교생은, AI를 치운 시험에서
 *     **AI를 아예 안 쓴 학생보다 17% 낮았다.** 우리 개념 카드가 그 형태다.
 *
 * ## 순서가 곧 개입이다
 *
 *   1. 본문을 **가린다** — 보면서 쓰면 인출이 아니라 베끼기다.
 *   2. 학생이 자기 말로 쓴다.
 *   3. 원문을 다시 보여 준다(대조).
 *   4. 쓴 것은 캔버스에 **자식 글로 남는다** — 사라지면 산출물이 아니다.
 *
 * 3번을 4번보다 먼저 두는 이유: 답을 확인하기 전에 저장을 끝내야 "고쳐 쓰고
 * 저장"이 안 된다. 그건 다시 베끼기가 된다.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Eye, X } from "lucide-react";

interface Props {
  /** 학생이 쓴 회상을 확정한다. 호출부가 자식 글로 만든다. */
  onCommit: (text: string) => void;
  onCancel: () => void;
  /** 대조 단계로 넘어가며 본문을 다시 보이게 한다. */
  onReveal: () => void;
}

export function RecallPanel({ onCommit, onCancel, onReveal }: Props) {
  const [value, setValue] = useState("");
  /** 썼고 이제 원문과 대조하는 단계인가. */
  const [revealed, setRevealed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const t = value.trim();
    if (!t) return;
    // 저장을 **먼저** 한다. 원문을 보고 나서 고칠 수 있으면 인출이 아니다.
    onCommit(t);
    setRevealed(true);
    onReveal();
  };

  if (revealed) {
    return (
      <div
        data-no-pan
        className="mt-2.5 rounded-lg px-3 py-2 text-[13px]"
        style={{
          background: "var(--c-hand-wash)",
          border: "1px solid var(--c-hand)",
          color: "var(--c-ink-soft)",
        }}
      >
        <div className="flex items-center gap-1.5" style={{ color: "var(--c-hand)" }}>
          <Check size={13} />
          <span className="font-medium">내가 쓴 것을 옆에 남겼어요</span>
        </div>
        <p className="mt-1 leading-relaxed">
          이제 원문과 비교해 보세요. <b>빠뜨린 것</b>이 있다면 그게 다시 봐야 할
          부분이에요.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="mt-1.5 rounded px-1.5 py-0.5 text-[12px] underline"
          style={{ color: "var(--c-ink-faint)" }}
        >
          닫기
        </button>
      </div>
    );
  }

  return (
    <div
      data-no-pan
      className="mt-2.5 rounded-lg px-3 py-2.5"
      style={{ background: "var(--c-sunk)", border: "1px solid var(--c-rule)" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium" style={{ color: "var(--c-ink)" }}>
          안 보고 다시 말해보기
        </span>
        <button
          type="button"
          onClick={onCancel}
          aria-label="그만두기"
          style={{ color: "var(--c-ink-faint)" }}
        >
          <X size={14} />
        </button>
      </div>
      <p className="mt-0.5 text-[12px]" style={{ color: "var(--c-ink-faint)" }}>
        기억나는 만큼만 자기 말로 써 보세요. 틀려도 괜찮아요 — 꺼내 보는 것 자체가
        공부예요.
      </p>
      <textarea
        ref={ref}
        value={value}
        rows={3}
        placeholder="예: 광합성은 빛으로 양분을 만드는…"
        onChange={(e) => setValue(e.target.value)}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={(e) => {
          e.stopPropagation(); // 도구 단축키가 발동하지 않게
          if (composing.current) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        className="mt-1.5 w-full resize-none rounded border-0 bg-transparent text-[14px] outline-none"
        style={{ color: "var(--c-ink)", caretColor: "var(--c-hand)", lineHeight: 1.7 }}
        aria-label="기억나는 내용 쓰기"
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        <span className="label" style={{ color: "var(--c-ink-faint)" }}>
          ⌘↵
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim()}
          className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium transition-opacity disabled:opacity-35"
          style={{ background: "var(--c-hand)", color: "var(--c-paper)" }}
        >
          <Eye size={12} />
          다 썼어요 · 원문 보기
        </button>
      </div>
    </div>
  );
}
