"use client";

/**
 * 아이템 본문 — 읽기 렌더 + 편집.
 *
 * 편집은 `contenteditable`이 아니라 `<textarea>`다. contenteditable은 붙여넣기
 * 때 서식 HTML이 그대로 들어오고, 한글 IME 조합 중 커서가 튀고, 되돌리기가
 * 브라우저마다 다르다. 여기서 다루는 건 마크업이 든 **평문**이라 textarea로
 * 충분하다.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toBlocks } from "@/lib/canvas2/markup";
import { INK_TAIL, splitRun, toInkDoc, type InkBlock, type InkRun } from "@/lib/canvas2/ink";
import { tuneOf } from "@/lib/canvas2/handScript";
import { useTypewriter } from "@/lib/canvas2/useTypewriter";
import { TunedText } from "./TunedText";

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
  /**
   * 글자 단위 타이핑 — 저장값(body 원문)과 표시값을 분리한다.
   *
   * `enabled`를 `streaming`으로 쓰면 안 된다. 스트림이 끝나는 순간
   * `_pending=false`가 되어 enabled가 false로 떨어지고, **아직 안 드러난
   * 글자가 한 번에 튀어나온다**. "한 번 타이핑을 시작했나"로 따로 기억해
   * 스트림이 끝난 뒤에도 CATCHUP 속도로 마무리하게 둔다.
   */
  const { shown: chars, typing } = useTypewriter(body.length, !!streaming);
  const visible = typing ? body.slice(0, chars) : body;

  // 매 프레임 파싱을 피한다 — toBlocks는 글자당 토큰 객체를 만든다.
  const doc = useMemo(() => toInkDoc(toBlocks(visible)), [visible]);
  const blocks = doc.blocks;
  const [open, setOpen] = useState(false);
  // 스트리밍 중에는 접지 않는다 — 글이 자라는 걸 보는 게 이 화면의 재미다.
  const folded = !open && !streaming && blocks.length > FOLD_AFTER;
  const shownBlocks = folded ? blocks.slice(0, FOLD_AFTER) : blocks;

  /**
   * 이 색인부터가 "지금 써지는" 글자다 (D164).
   *
   * 타이핑이 아닐 때 `Infinity`인 것이 중요하다 — 재수화된 글은 쪼개지도,
   * 애니메이션하지도 않는다. 새로고침할 때마다 온 캔버스가 다시 써지면
   * 학생이 이미 읽은 글을 또 기다려야 한다.
   */
  const writing = typing || !!streaming;
  const tailFrom = writing ? doc.total - INK_TAIL : Infinity;

  return (
    /**
     * `data-writing`은 **지금 이 글이 써지는 중**이라는 표식이다 (D164).
     *
     * E2E가 "어느 아이템이 자라고 있나"를 골라내는 데 쓴다 — 캔버스에 이미
     * 여러 글이 있으면 전체 글자 수만 봐서는 뭉텅 붙은 것과 한 글자씩 얹힌
     * 것이 구분되지 않는다. 스타일은 붙이지 않는다.
     */
    <div data-writing={writing ? "1" : undefined}>
      {shownBlocks.map((b, i) => (
        <Block
          key={b.start}
          block={b}
          tailFrom={tailFrom}
          last={(typing || streaming) && i === shownBlocks.length - 1}
        />
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

/**
 * 런 하나의 내용 — 마른 앞부분은 통째로, 지금 써지는 꼬리는 글자마다 (D164).
 *
 * key가 배열 위치가 아니라 **절대 색인**인 것이 이 컴포넌트의 전부다. 꼬리가
 * 한 칸 나아갈 때 React가 같은 글자의 span을 그대로 재사용해야 애니메이션이
 * 한 번만 돈다(`lib/canvas2/ink.ts` 주석 참조).
 */
function RunContent({ run, tailFrom }: { run: InkRun; tailFrom: number }) {
  const { dry, wet } = splitRun(run, tailFrom);
  return (
    <>
      {dry && (
        <span key="dry">
          <TunedText text={dry} />
        </span>
      )}
      {wet.map(([at, ch]) => {
        // 꼬리는 이미 글자 하나씩이라 구간을 나눌 게 없다 — 그 글자만 판정한다.
        const tune = tuneOf(ch.codePointAt(0)!);
        return (
          <span
            key={at}
            data-ink="1"
            data-tune={tune ?? undefined}
            className={tune ? "c2-ink c2-tune" : "c2-ink"}
          >
            {ch}
          </span>
        );
      })}
    </>
  );
}

function Block({
  block,
  tailFrom,
  last,
}: {
  block: InkBlock;
  tailFrom: number;
  last?: boolean;
}) {
  const content = (
    <>
      {block.runs.map((r) =>
        r.h ? (
          <mark
            key={r.start}
            style={{ background: "var(--c-mark)", color: "inherit", padding: "0 1px" }}
          >
            {r.b ? (
              <b>
                <RunContent run={r} tailFrom={tailFrom} />
              </b>
            ) : (
              <RunContent run={r} tailFrom={tailFrom} />
            )}
          </mark>
        ) : r.b ? (
          <b key={r.start} style={{ fontWeight: 700 }}>
            <RunContent run={r} tailFrom={tailFrom} />
          </b>
        ) : (
          <span key={r.start}>
            <RunContent run={r} tailFrom={tailFrom} />
          </span>
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

/**
 * 쓰는 손 — 펜 (D165).
 *
 * 막대 캐럿을 펜 그림으로 바꾼다. 이유는 글자 wipe의 **세로 경계를 가리는**
 * 것이다 — 경계가 그대로 보이면 "잘려 있다"로 읽히고, 펜이 그 자리에 있으면
 * "지금 여기서 나오는 중"으로 읽힌다.
 *
 * 펜은 촉이 좌하단(3,31)에 오도록 그렸다. 배치·회전축·흔들림은 전부
 * `globals.css`의 `.c2-nib`이 잡는다 — 촉 좌표와 transform-origin(9% 91%)이
 * 묶여 있으므로 SVG 좌표를 바꾸면 CSS도 같이 바꿔야 한다.
 *
 * 사라질 때 페이드는 없다. 마지막 글자의 wipe(0.22s)가 끝나는 순간 함께
 * 사라지는데, 그 자체가 부드러운 마무리라 상태를 하나 더 두면서까지 200ms를
 * 벌 이유가 없다.
 */
function Caret() {
  return (
    <span aria-hidden data-nib="1" className="c2-nib">
      <svg viewBox="0 0 34 34" fill="none">
        {/* 촉 — 회전축이자 글이 나오는 지점 */}
        <path d="M4.9 24.9 L9.1 29.1 L3 31 Z" fill="currentColor" />
        {/* 몸통 — 종이색으로 채워야 아래 글자가 비쳐 보이지 않는다 */}
        <path
          d="M4.9 24.9 L22.9 6.9 L27.1 11.1 L9.1 29.1 Z"
          fill="var(--c-paper)"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        {/* 뚜껑 */}
        <path
          d="M22.9 6.9 L26.9 2.9 L31.1 7.1 L27.1 11.1 Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </span>
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
  /** 이미 저장했나. blur와 언마운트가 둘 다 불릴 수 있어 한 번으로 묶는다. */
  const saved = useRef(false);

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

  /**
   * 저장은 **blur에서만** 한다.
   *
   * 배경을 클릭해도 내용이 남아야 하는데(사용자 지시), 한때 언마운트 정리에서
   * 커밋하도록 만들었다가 정확히 반대 결과가 났다 — React StrictMode는 개발에서
   * 이펙트를 mount → cleanup → mount로 두 번 돌리고, 그 가짜 cleanup이 빈
   * 문자열로 즉시 확정해 **편집기가 뜨자마자 닫혔다.** 언마운트는 "학생이 편집을
   * 끝냈다"는 신호가 아니다(세션 전환·삭제도 언마운트다).
   *
   * 대신 배경 클릭 쪽에서 textarea를 먼저 blur시킨다(CanvasWorkspace 참조).
   * blur는 동기적으로 처리되므로 편집 상태가 꺼지기 전에 저장이 끝난다.
   */
  const commit = (next: string) => {
    if (saved.current) return;
    saved.current = true;
    onCommit(next);
  };

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
          // 되돌리기다 — 언마운트 저장이 덮어쓰지 않게 잠근다.
          saved.current = true;
          onCancel();
        }
        // Enter는 줄바꿈이다. 확정은 ⌘/Ctrl+Enter — 여러 문단을 쓰는 화면이라
        // Enter를 확정에 쓰면 글을 쓸 수가 없다.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit(value);
        }
      }}
      onBlur={() => commit(value)}
      // 테두리·바탕을 주지 않는다(사용자 지시) — 캔버스에 바로 쓰는 느낌이어야
      // 하고, 입력 폼처럼 보이면 안 된다. outline-none은 브라우저 기본 포커스
      // 링까지 없앤다.
      className="w-full resize-none border-0 bg-transparent outline-none focus:outline-none focus:ring-0"
      style={{
        lineHeight: 1.75,
        color: "var(--c-ink)",
        caretColor: "var(--c-live)",
        minHeight: "3em",
        boxShadow: "none",
      }}
      aria-label="본문 수정"
    />
  );
}
