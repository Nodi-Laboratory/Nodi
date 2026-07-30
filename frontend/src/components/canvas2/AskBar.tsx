"use client";

/**
 * 공중 입력창 — `BottomBar`를 대체한다.
 *
 * 캔버스 위에 떠 있는 알약 하나. 평소에는 한 줄이고 포커스하면 늘어난다.
 * 학생 글의 "AI에게 묻기"로 열리면 그 글이 **인용 칩**으로 위에 붙는다 —
 * 무엇에 대해 묻는지 보이지 않으면 답이 어디에 붙을지도 모른다.
 */

import { ArrowUp, Paperclip, Quote, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
  busy: boolean;
  /** 스트리밍 중 말풍선 문구. */
  reply: string;
  /** "AI에게 묻기"로 열렸을 때 인용할 글. */
  quote: { id: string; text: string } | null;
  onClearQuote: () => void;
  onSend: (question: string, parentItemId: string | null) => void;
  disabled?: boolean;
  /** 세션 컨텍스트 파일 첨부 (D83). 없으면 버튼을 숨긴다. */
  onAttach?: (file: File) => void;
}

export function AskBar({ busy, reply, quote, onClearQuote, onSend, disabled, onAttach }: Props) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 한글 조합 중 Enter는 IME의 확정이다. 가로채면 마지막 글자가 잘린 채 전송된다
  // (v1 BottomBar에서 실측으로 얻은 가드 — 반드시 유지한다).
  const composing = useRef(false);

  useEffect(() => {
    if (quote) taRef.current?.focus();
  }, [quote]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  const submit = () => {
    const q = value.trim();
    if (!q || busy || disabled) return;
    onSend(q, quote?.id ?? null);
    setValue("");
    onClearQuote();
  };

  const showStatus = busy && reply;

  return (
    <div
      data-no-pan
      className="ui absolute bottom-6 left-1/2 z-30 w-[min(680px,calc(100%-140px))] -translate-x-1/2"
    >
      {showStatus && (
        <div
          className="mb-2 flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-[13px]"
          style={{
            background: "var(--c-raised)",
            border: "1px solid var(--c-rule)",
            color: "var(--c-ink-soft)",
            boxShadow: "var(--c-shadow-sm)",
          }}
        >
          <span className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="inline-block h-1 w-1 rounded-full"
                style={{
                  background: "var(--c-live)",
                  animation: `c2-bounce .9s ease-in-out ${i * 0.15}s infinite`,
                }}
              />
            ))}
          </span>
          {reply}
        </div>
      )}

      {quote && (
        <div
          className="mb-2 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]"
          style={{
            background: "var(--c-hand-wash)",
            border: "1px solid var(--c-hand)",
            color: "var(--c-ink)",
          }}
        >
          <Quote size={13} style={{ color: "var(--c-hand)", marginTop: 3 }} />
          <span className="min-w-0 flex-1 line-clamp-2">{quote.text}</span>
          <button
            type="button"
            onClick={onClearQuote}
            aria-label="인용 지우기"
            style={{ color: "var(--c-ink-faint)" }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div
        className="flex items-end gap-2 rounded-2xl border px-3 py-2 transition-shadow"
        style={{
          background: "var(--c-raised)",
          // **포커스에 테두리를 칠하지 않는다**(사용자 지시). 누를 때마다
          // 오커 링이 켜지는 게 거슬린다는 지적이었다. 포커스 여부는 그림자
          // 깊이로만 알린다 — 알림은 남기되 색은 쓰지 않는다.
          borderColor: "var(--c-rule)",
          boxShadow: focused ? "var(--c-shadow-lg)" : "var(--c-shadow-md)",
        }}
      >
        {onAttach && (
          <label
            className="mb-0.5 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-[var(--c-sunk)]"
            style={{ color: "var(--c-ink-soft)" }}
            title="파일 첨부"
          >
            <Paperclip size={16} />
            <input
              type="file"
              className="hidden"
              disabled={disabled}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onAttach(f);
                e.target.value = ""; // 같은 파일을 다시 골라도 change가 나게
              }}
            />
          </label>
        )}
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={
            disabled ? "세션을 준비하는 중이에요" : quote ? "이 글에 대해 물어보세요" : "무엇이 궁금한가요?"
          }
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            e.stopPropagation(); // 도구 단축키가 입력 중에 발동하지 않게
            if (composing.current) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-[15px] outline-none"
          style={{ color: "var(--c-ink)", caretColor: "var(--c-live)" }}
          aria-label="질문 입력"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim() || busy || disabled}
          aria-label="보내기"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-30"
          style={{ background: "var(--c-live-deep)", color: "var(--c-paper)" }}
        >
          <ArrowUp size={16} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
}
