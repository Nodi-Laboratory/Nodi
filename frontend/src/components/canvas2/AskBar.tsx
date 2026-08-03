"use client";

/**
 * 공중 입력창 — `BottomBar`를 대체한다.
 *
 * 캔버스 위에 떠 있는 알약 하나. 평소에는 한 줄이고 포커스하면 늘어난다.
 * AI 답의 "다시 질문하기"로 열리면 그 답이 **인용 칩**으로 위에 붙는다 —
 * 무엇에 대해 묻는지 보이지 않으면 답이 어디에 붙을지도 모른다(D149).
 */

import { ArrowUp, Paperclip, Quote, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
  busy: boolean;
  /** 스트리밍 중 말풍선 문구. */
  reply: string;
  /** 지금 고른 트리 노드 — 다음 답이 여기에 붙는다 (D151). */
  quote: { id: string; text: string; tag?: string | null } | null;
  onClearQuote: () => void;
  /**
   * 입력창에 포커스를 달라는 신호 — 올라갈 때마다 커서를 여기로 옮긴다 (D157).
   *
   * 예전에는 인용 칩이 생기면 무조건 포커스했다. 그런데 방향키로 트리를
   * 걸으면 걸음마다 칩이 바뀌고, 첫 걸음에 커서가 입력창으로 끌려가면서
   * **그 다음 방향키가 전부 입력으로 먹혔다**(실측: 첫 키만 듣고 이후 무반응).
   * "묻겠다"는 뜻일 때만 포커스한다.
   */
  focusSignal: number;
  onSend: (question: string) => void;
  disabled?: boolean;
  /** 세션 컨텍스트 파일 첨부 (D83). 없으면 버튼을 숨긴다. */
  onAttach?: (file: File) => void;
}

export function AskBar({
  busy,
  reply,
  quote,
  onClearQuote,
  onSend,
  disabled,
  onAttach,
  focusSignal,
}: Props) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 한글 조합 중 Enter는 IME의 확정이다. 가로채면 마지막 글자가 잘린 채 전송된다
  // (v1 BottomBar에서 실측으로 얻은 가드 — 반드시 유지한다).
  const composing = useRef(false);

  useEffect(() => {
    if (focusSignal) taRef.current?.focus();
  }, [focusSignal]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  const submit = () => {
    const q = value.trim();
    if (!q || busy || disabled) return;
    onSend(q);
    setValue("");
  };

  /**
   * **보내는 순간부터 보인다** (D160, 사용자 지적 2026-08-03: "AI가 생각하는
   * 시간 동안 아무 내용이 없어서 렉 걸리는 것처럼 보인다").
   *
   * 예전에는 `busy && reply`였다 — 모델이 첫 토큰을 뱉기 전까지 `reply`가
   * 비어 있어서 **가장 긴 침묵 구간에 아무것도 안 떴다.** 도구를 쓰는 턴은
   * 그 구간이 특히 길다(검색·읽기). 문구가 아직 없으면 기본 문구를 쓴다.
   */
  const showStatus = busy;
  const statusText = reply || "생각하고 있어요…";

  return (
    <div
      data-no-pan
      // bottom-6이었다. 아래 방향 버튼(D157)이 입력창 **아래**에 놓이므로
      // 그만큼 올린다 — 사용자 지시: "아래쪽 버튼은 입력 공간의 아래에".
      className="ui absolute bottom-[52px] left-1/2 z-30 w-[min(680px,calc(100%-140px))] -translate-x-1/2"
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
          {statusText}
        </div>
      )}

      {quote && (
        <div
          className="mb-2 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]"
          // 인용하는 것은 **AI가 쓴 답**이다 — 괘선과 같은 오커로 출처를 맞춘다.
          style={{
            /**
             * **불투명해야 한다** (사용자 지적 2026-08-02: "불투명도가 너무
             * 낮아서 배경의 글자와 겹치면 잘 안 보인다").
             *
             * `--c-live-wash`는 알파 0.09라 캔버스 글자가 그대로 비친다.
             * 이 칩은 캔버스 **위에 떠 있는 UI**라 아래가 비치면 읽을 수
             * 없다. 색조는 지키면서 불투명하게 만들려고 wash를 불투명한
             * `--c-raised` 위에 한 겹 깐다 — 토큰을 그대로 쓰면서 결과는
             * 완전 불투명이다(테마가 바뀌어도 따라간다).
             */
            background:
              "linear-gradient(var(--c-live-wash), var(--c-live-wash)), var(--c-raised)",
            border: "1px solid var(--c-live)",
            color: "var(--c-ink)",
            // 아래 입력창과 같은 깊이로 떠 있게 — 한 덩어리로 읽힌다.
            boxShadow: "var(--c-shadow-md)",
          }}
        >
          <Quote size={13} style={{ color: "var(--c-live)", marginTop: 3 }} />
          <span className="min-w-0 flex-1">
            {/* 어느 트리에 붙는지가 인용문보다 중요하다 (D151) */}
            {quote.tag && (
              <span className="mr-1.5 font-medium" style={{ color: "var(--c-live)" }}>
                [{quote.tag}]
              </span>
            )}
            <span className="line-clamp-2">{quote.text}</span>
          </span>
          <button
            type="button"
            onClick={onClearQuote}
            aria-label="이어 묻기 그만두기"
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
            disabled
              ? "세션을 준비하는 중이에요"
              : quote
                ? `${quote.tag ? `[${quote.tag}] ` : ""}이 답에 이어서 물어보세요`
                : "무엇이 궁금한가요?"
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
