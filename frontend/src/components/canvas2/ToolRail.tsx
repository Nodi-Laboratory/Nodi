"use client";

/**
 * 우측 세로 도구 레일 (D120).
 *
 * Excalidraw 기본 툴바를 끄고 이걸 쓴다. 단축키는 Excalidraw와 **같게** 둔다 —
 * 다른 그리기 도구를 써 본 학생이 손에 익은 키를 그대로 쓸 수 있게.
 *
 * `note`만 우리 도구다. Excalidraw의 텍스트 요소가 아니라 우리 아이템을
 * 만들기 때문에 Excalidraw에는 선택 도구를 물려 두고 캔버스 클릭을 오버레이가
 * 가로챈다.
 */

import {
  ArrowUpRight,
  Circle,
  Eraser,
  Hand,
  Minus,
  MousePointer2,
  Pencil,
  Square,
  Type,
} from "lucide-react";
import { useEffect } from "react";
import type { ToolName } from "@/lib/canvas2/types";

interface ToolDef {
  tool: ToolName;
  icon: typeof Pencil;
  label: string;
  key: string;
}

/** 구분선 위치를 담기 위해 그룹으로 나눈다. */
const GROUPS: ToolDef[][] = [
  [
    { tool: "selection", icon: MousePointer2, label: "선택", key: "v" },
    { tool: "hand", icon: Hand, label: "화면 이동", key: "h" },
  ],
  [
    { tool: "note", icon: Type, label: "글 쓰기", key: "t" },
  ],
  [
    { tool: "freedraw", icon: Pencil, label: "자유선", key: "p" },
    { tool: "rectangle", icon: Square, label: "사각형", key: "r" },
    { tool: "ellipse", icon: Circle, label: "원", key: "o" },
    { tool: "arrow", icon: ArrowUpRight, label: "화살표", key: "a" },
    { tool: "line", icon: Minus, label: "선", key: "l" },
  ],
  [{ tool: "eraser", icon: Eraser, label: "지우개", key: "e" }],
];

const ALL = GROUPS.flat();

interface Props {
  active: ToolName;
  onSelect: (tool: ToolName) => void;
}

export function ToolRail({ active, onSelect }: Props) {
  // 단축키. 입력 중일 때는 절대 가로채지 않는다 — 학생이 글을 쓰다가
  // 'p'를 치면 자유선으로 바뀌는 사고를 막는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 한글 조합 중에는 도구를 바꾸지 않는다. IME에 따라 라틴 키가 새어
      // 들어올 수 있다.
      if (e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      const hit = ALL.find((d) => d.key === e.key.toLowerCase());
      if (hit) {
        e.preventDefault();
        // Excalidraw도 document에서 같은 키를 듣는다 — `t`는 저쪽에서
        // 텍스트 요소를 만든다. 전파를 끊어야 우리 note 도구만 켜진다.
        e.stopPropagation();
        onSelect(hit.tool);
      }
    };
    // capture로 받는다 — Excalidraw도 document에 붙어 있어서, 버블 단계에서는
    // 이미 저쪽이 처리한 뒤다.
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [onSelect]);

  return (
    <div
      data-no-pan
      className="ui absolute right-4 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-xl border p-1.5"
      style={{
        background: "var(--c-raised)",
        borderColor: "var(--c-rule)",
        boxShadow: "var(--c-shadow-md)",
      }}
    >
      {GROUPS.map((group, gi) => (
        <div key={gi} className="flex flex-col gap-1">
          {gi > 0 && (
            <div className="mx-1.5 my-0.5 h-px" style={{ background: "var(--c-rule)" }} />
          )}
          {group.map(({ tool, icon: Icon, label, key }) => (
            <ToolButton
              key={tool}
              active={active === tool}
              label={label}
              hint={key.toUpperCase()}
              onClick={() => onSelect(tool)}
              // 학생의 손(그리기·글쓰기)은 주황, 선택/이동은 중립
              accent={tool === "selection" || tool === "hand" ? "neutral" : "hand"}
            >
              <Icon size={17} strokeWidth={1.9} />
            </ToolButton>
          ))}
        </div>
      ))}

      <div className="mx-1.5 my-0.5 h-px" style={{ background: "var(--c-rule)" }} />
      {/* 실행 취소는 **키보드로만** 제공한다.
          Excalidraw는 undo/redo를 공개 API로 주지 않고(`history.clear()`만
          있다), 합성 KeyboardEvent는 그 경로에 닿지 않는다 — 실측으로
          확인했다(진짜 키보드 Ctrl+Z는 요소 10→9로 동작, 합성 이벤트는 무동작).
          우리 스냅샷 스택으로 직접 만들어 봤으나 Excalidraw의 onChange와
          맞물려 무한 렌더가 났다. **아무 일도 안 하는 버튼을 두는 것보다
          없는 편이 낫다** — 대신 여기서 단축키를 알려 준다. */}
      <div
        className="label px-1 py-1.5 text-center leading-tight"
        style={{ color: "var(--c-ink-faint)", letterSpacing: 0 }}
        title="그림 되돌리기는 키보드 단축키를 씁니다"
      >
        ⌘Z
      </div>
    </div>
  );
}

function ToolButton({
  active,
  label,
  hint,
  onClick,
  accent,
  children,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
  accent: "neutral" | "hand";
  children: React.ReactNode;
}) {
  const on = accent === "hand" ? "var(--c-hand)" : "var(--c-ink)";
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} (${hint})`}
      aria-label={label}
      aria-pressed={active}
      className="group relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors"
      style={{
        background: active ? (accent === "hand" ? "var(--c-hand-wash)" : "var(--c-sunk)") : "transparent",
        color: active ? on : "var(--c-ink-soft)",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--c-sunk)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
      {/* 단축키는 hover에만. 평소에 다 보이면 레일이 시끄럽다 */}
      <span
        className="label pointer-events-none absolute right-full mr-2 whitespace-nowrap rounded px-1.5 py-1 opacity-0 transition-opacity group-hover:opacity-100"
        style={{ background: "var(--c-ink)", color: "var(--c-paper)" }}
      >
        {label} <span style={{ opacity: 0.55 }}>{hint}</span>
      </span>
    </button>
  );
}
