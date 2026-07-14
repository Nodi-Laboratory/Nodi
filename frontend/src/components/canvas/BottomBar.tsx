"use client";

// Bottom bar: Nodi avatar (radar ping while streaming) + streaming speech bubble
// + input. Ported from Nodi-figma/components/BottomBar.js. No voice UI.

import { useState } from "react";
import styles from "./BottomBar.module.css";

const IDLE = "궁금한 개념을 말하거나, 입력해보세요.";

export default function BottomBar({
  onSend,
  busy,
  reply,
}: {
  onSend: (q: string) => void;
  busy: boolean;
  reply: string;
}) {
  const [text, setText] = useState("");
  const [imgBroken, setImgBroken] = useState(false);

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
