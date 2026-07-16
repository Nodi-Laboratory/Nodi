"use client";

// Bottom bar: Nodi avatar (radar ping while streaming) + streaming speech bubble
// + input. Ported from Nodi-figma/components/BottomBar.js. No voice UI.

import { useRef, useState } from "react";
import { Loader2, Paperclip } from "lucide-react";
import styles from "./BottomBar.module.css";

const IDLE = "궁금한 개념을 말하거나, 입력해보세요.";

export default function BottomBar({
  onSend,
  busy,
  reply,
  onAttach,
  attachBusy,
}: {
  onSend: (q: string) => void;
  busy: boolean;
  reply: string;
  // D83 부속: 프롬프트 창 첨부. 미제공 시 클립 버튼을 렌더하지 않는다(하위 호환).
  onAttach?: (file: File) => void;
  attachBusy?: boolean;
}) {
  const [text, setText] = useState("");
  const [imgBroken, setImgBroken] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일 재선택 허용
    if (file) onAttach?.(file);
  };

  const submit = () => {
    const q = text.trim();
    if (!q || busy) return;
    onSend(q);
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Don't submit while a Korean IME composition is in progress.
    if (
      e.key === "Enter" &&
      !(e.nativeEvent as unknown as { isComposing: boolean }).isComposing
    ) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={styles.bar} data-testid="bottom-bar">
      <div className={styles.avatar}>
        <span className={`${styles.ping} ${busy ? styles.pinging : ""}`} />
        <span className={styles.ring}>
          {imgBroken ? (
            <svg className={styles.face} viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="32" fill="#FFFBEE" />
              <circle cx="24" cy="29" r="3.2" fill="#2B2620" />
              <circle cx="40" cy="29" r="3.2" fill="#2B2620" />
              <path
                d="M22 39 Q32 47 42 39"
                fill="none"
                stroke="#2B2620"
                strokeWidth="2.6"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className={styles.faceImg}
              src="/nodi-mascot.png"
              alt="노디"
              onError={() => setImgBroken(true)}
            />
          )}
        </span>
      </div>

      <div className={styles.center}>
        <div
          className={styles.bubble}
          key={reply ? "reply" : busy ? "thinking" : "idle"}
        >
          {reply ? (
            reply
          ) : busy ? (
            <span className={styles.dots} role="status" aria-label="생각 중">
              <span className={styles.dot} />
              <span className={styles.dot} />
              <span className={styles.dot} />
            </span>
          ) : (
            IDLE
          )}
        </div>
        <div className={styles.inputBar}>
          <input
            className={styles.input}
            data-testid="chat-input"
            type="text"
            value={text}
            placeholder="노디에게 궁금한 개념을 물어보세요…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            data-no-pan
          />
          {onAttach && (
            <>
              <button
                className={styles.attach}
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={attachBusy}
                aria-label="파일 첨부"
                title="이 세션의 컨텍스트로 파일 첨부"
                data-no-pan
              >
                {attachBusy ? (
                  <Loader2 size={18} className={styles.attachSpin} />
                ) : (
                  <Paperclip size={18} />
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md"
                className={styles.hiddenInput}
                onChange={onPick}
              />
            </>
          )}
          <button
            className={styles.send}
            type="button"
            onClick={submit}
            disabled={busy}
            aria-label="보내기"
            data-no-pan
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 18 V7 M6 12 L12 6 L18 12"
                fill="none"
                stroke="#2B2620"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div className={styles.spacer} aria-hidden="true" />
    </div>
  );
}
