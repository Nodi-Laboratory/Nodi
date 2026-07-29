"use client";

/**
 * 아이템 본문 — 읽기 렌더 + 편집.
 *
 * 편집은 `contenteditable`이 아니라 `<textarea>`다. contenteditable은 붙여넣기
 * 때 서식 HTML이 그대로 들어오고, 한글 IME 조합 중 커서가 튀고, 되돌리기가
 * 브라우저마다 다르다. 여기서 다루는 건 마크업이 든 **평문**이라 textarea로
 * 충분하다.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toBlocks, toRuns } from "@/lib/canvas2/markup";
import type { RenderBlock } from "@/lib/canvas2/types";

/** 이 블록 수를 넘으면 접는다. 열이 화면 몇 개 높이로 길어지는 걸 막는다. */
const FOLD_AFTER = 6;

interface Props {
  body: string;
  editing: boolean;
  onCommit: (next: string) => void;
  onCancel: () => void;
  /** 스트리밍 중이면 캐럿을 붙인다. */
  streaming?: boolean;
}

export function ItemBody({ body, editing, onCommit, onCancel, streaming }: Props) {
  if (editing) {
    return <BodyEditor body={body} onCommit={onCommit} onCancel={onCancel} />;
  }
  return <BodyView body={body} streaming={streaming} />;
}

function BodyView({ body, streaming }: { body: string; streaming?: boolean }) {
  const blocks = toBlocks(body);
  const [open, setOpen] = useState(false);
  // 스트리밍 중에는 접지 않는다 — 글이 자라는 걸 보는 게 이 화면의 재미다.
  const folded = !open && !streaming && blocks.length > FOLD_AFTER;
  const shown = folded ? blocks.slice(0, FOLD_AFTER) : blocks;

  return (
    <div>
      {shown.map((b, i) => (
        <Block key={i} block={b} last={streaming && i === shown.length - 1} />
      ))}
      {folded && (
        <button
          type="button"
          data-no-pan
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className="label mt-2 rounded px-1.5 py-1 transition-colors"
          style={{ color: "var(--c-ink-faint)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--c-ink)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--c-ink-faint)")}
        >
          + {blocks.length - FOLD_AFTER}문단 더 보기
        </button>
      )}
    </div>
  );
}

function Block({ block, last }: { block: RenderBlock; last?: boolean }) {
  const runs = toRuns(block.tokens);
  const content = (
    <>
      {runs.map((r, i) =>
        r.h ? (
          <mark
            key={i}
            style={{ background: "var(--c-mark)", color: "inherit", padding: "0 1px" }}
          >
            {r.b ? <b>{r.text}</b> : r.text}
          </mark>
        ) : r.b ? (
          <b key={i} style={{ fontWeight: 700 }}>
            {r.text}
          </b>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
      {last && <Caret />}
    </>
  );

  if (block.type === "li") {
    return (
      <div className="mt-1.5 flex gap-2 first:mt-0">
        <span aria-hidden style={{ color: "var(--c-ink-faint)", lineHeight: 1.75 }}>
          ·
        </span>
        <p className="flex-1" style={{ lineHeight: 1.75 }}>
          {content}
        </p>
      </div>
    );
  }
  return (
    <p className="mt-3 first:mt-0" style={{ lineHeight: 1.75 }}>
      {content}
    </p>
  );
}

function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block w-[2px] align-text-bottom"
      style={{
        height: "1em",
        background: "var(--c-live)",
        animation: "c2-caret 1s step-end infinite",
      }}
    />
  );
}

function BodyEditor({
  body,
  onCommit,
  onCancel,
}: {
  body: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(body);
  const composing = useRef(false);

  // 내용에 맞춰 높이를 늘린다. 스크롤바가 생기면 캔버스 위에서 읽기가 최악이다.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <textarea
      ref={ref}
      data-no-pan
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => (composing.current = false)}
      onKeyDown={(e) => {
        e.stopPropagation(); // 도구 단축키가 편집 중에 발동하지 않게
        // 한글 조합 중 Esc/Enter는 IME의 것이다 — 가로채면 조합이 깨진다.
        if (composing.current) return;
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        // Enter는 줄바꿈이다. 확정은 ⌘/Ctrl+Enter — 여러 문단을 쓰는 화면이라
        // Enter를 확정에 쓰면 글을 쓸 수가 없다.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCommit(value);
        }
      }}
      onBlur={() => onCommit(value)}
      className="w-full resize-none bg-transparent outline-none"
      style={{
        lineHeight: 1.75,
        color: "var(--c-ink)",
        caretColor: "var(--c-live)",
        minHeight: "3em",
      }}
      aria-label="본문 수정"
    />
  );
}
