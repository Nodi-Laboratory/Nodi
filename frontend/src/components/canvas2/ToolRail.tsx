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
  ChevronLeft,
  Circle,
  Eraser,
  Hand,
  Highlighter,
  Minus,
  MousePointer2,
  PenLine,
  Pencil,
  Square,
  Sparkles,
  Type,
  X,
} from "lucide-react";
import { useEffect } from "react";
import type { DrawStyle, ToolName } from "@/lib/canvas2/types";
import { useChromeFit } from "@/lib/canvas2/useChromeFit";
import { SNAP_MARGIN } from "@/lib/canvas2/cornerSnap";
import { scaled } from "@/lib/ui/scale";
import { isColorableTool } from "@/lib/canvas2/types";
import { useCollapsible, useStickyChoice } from "@/lib/canvas2/useCollapsible";

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
    /**
     * 카드 수정 (D180) — **관계를 손으로 다시 엮는다.**
     *
     * 질문하는 펜 **위**에 둔다(사용자 지시 2026-08-05). 둘 다 캔버스에 이미
     * 있는 것을 다루는 도구이고, 아래 그룹의 그리기 도구(자국을 남기는 것)와
     * 성격이 다르다.
     *
     * `s`는 star. Excalidraw가 안 쓰는 키다 — 손에 익은 키를 다른 뜻으로
     * 쓰지 않는다는 이 레일의 규칙(파일 머리말) 그대로다.
     */
    { tool: "cardedit", icon: Sparkles, label: "카드 수정", key: "s" },
    /**
     * 질문하는 펜 (D176) — 캔버스에 손으로 질문을 쓴다. 쓰고 나면 하단
     * 입력창의 버튼이 "글자 인식"으로 바뀐다.
     *
     * 글 쓰기(note)와 나란히 둔다: 둘 다 **무언가를 만드는** 도구이고,
     * 아래 그룹의 그리기 도구(자국을 남기는 것)와 성격이 다르다.
     */
    { tool: "askpen", icon: PenLine, label: "질문하는 펜", key: "q" },
    { tool: "note", icon: Type, label: "글 쓰기", key: "t" },
  ],
  [
    { tool: "freedraw", icon: Pencil, label: "자유선", key: "p" },
    // `d`는 Excalidraw에서 마름모라 쓰지 않는다(우리가 가로채지만 손에 익은
    // 키를 다른 뜻으로 쓰면 혼란스럽다). `m`은 marker.
    { tool: "highlighter", icon: Highlighter, label: "형광펜", key: "m" },
    { tool: "rectangle", icon: Square, label: "사각형", key: "r" },
    { tool: "ellipse", icon: Circle, label: "원", key: "o" },
    { tool: "arrow", icon: ArrowUpRight, label: "화살표", key: "a" },
    { tool: "line", icon: Minus, label: "선", key: "l" },
  ],
  [{ tool: "eraser", icon: Eraser, label: "지우개", key: "e" }],
];

const ALL = GROUPS.flat();

/**
 * 색 (D150).
 *
 * 값은 Excalidraw가 쓰는 open-color 계열 그대로다 — 우리가 임의로 고르면
 * 같은 캔버스 위에서 저쪽 기본 색과 톤이 어긋난다.
 *
 * 펜은 **먹**이 기본이다. 형광펜은 노랑 — 종이에서와 같다.
 */
const PEN_COLORS = [
  { name: "먹", value: "#1e1e1e" },
  { name: "빨강", value: "#e03131" },
  { name: "주황", value: "#f08c00" },
  { name: "초록", value: "#2f9e44" },
  { name: "파랑", value: "#1971c2" },
  { name: "보라", value: "#7048e8" },
] as const;

const HIGHLIGHT_COLORS = [
  { name: "노랑", value: "#ffec99" },
  { name: "연두", value: "#b2f2bb" },
  { name: "하늘", value: "#a5d8ff" },
  { name: "분홍", value: "#fcc2d7" },
  { name: "주황", value: "#ffd8a8" },
] as const;

/**
 * 형광펜 획 (D150).
 *
 * Excalidraw의 자유선은 `strokeWidth * 4.25`px로 그려진다(dist 실측). 6이면
 * 약 25px — 15px 글자를 넉넉히 덮는다. 투명도 40은 밑의 글자가 읽히면서도
 * 칠했다는 것이 보이는 지점이고, roughness 0은 손그림 떨림을 없앤다
 * (형광펜은 매끈한 띠여야지 스케치가 아니다).
 *
 * 획 끝이 살짝 가늘어지는 것은 감수한다 — Excalidraw의 자유선은 필압
 * (`thinning: .6`)이 코드에 박혀 있어 appState로 끌 수 없다.
 */
const HIGHLIGHT_STYLE = { opacity: 40, strokeWidth: 6, roughness: 0 } as const;
/** 펜·도형은 Excalidraw 기본값으로 되돌린다(형광펜을 쓴 뒤 그대로 남지 않게). */
const PEN_STYLE = { opacity: 100, strokeWidth: 2, roughness: 1 } as const;

interface Props {
  /**
   * 미니맵이 붙어 있는 모서리(닫혀 있으면 null) — 같은 변을 쓰면 비켜선다
   * (D211 9).
   */
  mapCorner?: "tl" | "tr" | "bl" | "br" | null;
  active: ToolName;
  onSelect: (tool: ToolName) => void;
  /** 다음에 그릴 것의 색·굵기·투명도를 정한다 (D150). */
  setDrawStyle: (style: DrawStyle) => void;
  /**
   * 지금은 도구를 바꾸지 않는다 (D176) — 펜 입력판을 편 동안.
   *
   * 누르는 것은 투명한 막이 막지만 **단축키는 못 막는다**. 이 핸들러는
   * document에 캡처로 붙어 있어서, 판 안에서 전파를 끊어도 이미 지난 뒤다.
   */
  paused?: boolean;
}

export function ToolRail({
  mapCorner = null, active, onSelect, setDrawStyle, paused = false }: Props) {
  const [fitRef, fit] = useChromeFit(mapCorner);
  const pen = useStickyChoice(
    "pen.color",
    PEN_COLORS.map((c) => c.value),
    PEN_COLORS[0].value,
  );
  const highlight = useStickyChoice(
    "highlight.color",
    HIGHLIGHT_COLORS.map((c) => c.value),
    HIGHLIGHT_COLORS[0].value,
  );
  const highlighting = active === "highlighter";
  const colors = highlighting ? HIGHLIGHT_COLORS : PEN_COLORS;
  const picked = highlighting ? highlight : pen;

  /**
   * 도구나 색이 바뀔 때마다 스타일을 다시 밀어 넣는다.
   *
   * 도구 전환 시점에 **반드시** 다시 써야 한다 — 형광펜에서 펜으로 돌아왔는데
   * 굵기·투명도가 그대로면 펜이 형광펜처럼 그려진다. "고른 도구가 곧 스타일"로
   * 두면 어느 순서로 눌러도 어긋나지 않는다.
   */
  useEffect(() => {
    if (!isColorableTool(active)) return;
    const s = highlighting ? HIGHLIGHT_STYLE : PEN_STYLE;
    setDrawStyle({ strokeColor: highlighting ? highlight.value : pen.value, ...s });
  }, [active, highlighting, highlight.value, pen.value, setDrawStyle]);

  /**
   * 접었다 펼 수 있다 (D140, 사용자 지시). 접으면 **지금 켜진 도구 하나만**
   * 남는다 — 무엇이 선택돼 있는지는 접어 둬도 알아야 한다.
   *
   * 기본은 펼침이고, 접어 두면 그대로 기억한다.
   */
  const { open, setOpen } = useCollapsible("tools", true);
  // 단축키. 입력 중일 때는 절대 가로채지 않는다 — 학생이 글을 쓰다가
  // 'p'를 치면 자유선으로 바뀌는 사고를 막는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused) return; // 펜으로 쓰는 중 (D176)
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
  }, [onSelect, paused]);

  // 접힘 — 켜진 도구 하나만 보여 주고, 누르면 펼친다.
  if (!open) {
    const cur = ALL.find((d) => d.tool === active) ?? ALL[0];
    const Icon = cur.icon;
    /**
     * 접힌 상태 — **세로로 긴 탭** (D210 5-3, 사용자 지시 2026-08-08).
     *
     * 정사각형 버튼이었다. 도구바는 세로로 긴데 접으면 정사각형이 되니
     * "여기서 그게 나온다"가 안 읽혔다. 탭이 세로로 길면 형태 자체가
     * 나올 것의 모양을 말해 준다.
     *
     * 오른쪽 변에 **붙인다**(right: 0, 모서리는 왼쪽만 둥글다) — 화면 밖에서
     * 미끄러져 나오는 인상이라 붙어 있어야 그 방향이 읽힌다.
     */
    return (
      <button
        type="button"
        data-no-pan
        data-rail-tab
        onClick={() => setOpen(true)}
        aria-label={`도구 펼치기 (지금: ${cur.label})`}
        title={`도구 펼치기 — 지금 ${cur.label}`}
        className="ui c2-rail-tab absolute right-0 top-1/2 z-30 flex w-8 -translate-y-1/2 flex-col items-center justify-center gap-1 border py-4"
        style={{
          height: 92,
          background: "var(--c-raised)",
          borderColor: "var(--c-rule)",
          borderRight: "none",
          borderTopLeftRadius: 10,
          borderBottomLeftRadius: 10,
          color: "var(--c-ink)",
          boxShadow: "var(--c-shadow-md)",
        }}
      >
        <ChevronLeft size={14} strokeWidth={2} aria-hidden />
        <Icon size={16} strokeWidth={1.9} />
      </button>
    );
  }

  return (
    // 오른쪽 **아래** — 사용자 지시. 하단 입력창은 가운데라 부딪히지 않는다.
    // 색 팔레트는 레일 **왼쪽**에 붙인다. 레일 안에 넣으면 세로로 더 길어져
    // 좁은 화면(교실 태블릿)에서 상단바까지 닿는다.
    <div
      ref={fitRef}
      data-rail-mode={fit.railMode}
      className="c2-rail-in absolute right-4 z-30 flex items-center gap-2"
      /**
       * 미니맵과 같은 변을 쓸 때의 자리 (사용자 지시 2026-08-08).
       *
       *   center  평소 — 세로 가운데. 겹치면 `railShift`만큼 비켜선다.
       *   top/bottom  밀 자리가 없다 — 지도와 **나란히** 서고 지도가 왼쪽으로
       *               물러난다(규칙은 `lib/canvas2/chromeFit.ts`).
       *
       * `margin-top`으로 미는 이유: `transform`은 등장 애니메이션(`c2-rail-in`)이
       * 이미 쓰고, 세로 가운데는 Tailwind의 `translate` 속성이 쓴다 — 거기 얹으면
       * 셋이 엉킨다(D210 5-3에서 실제로 도구바가 화면 위로 올라갔다).
       * 버튼 사이 간격은 어느 자리에서도 안 건드린다.
       */
      style={
        fit.railMode === "center"
          ? {
              // 화면보다 길면 안쪽 열이 굴러야 한다 — 그러려면 상한이 **여기**
              // 있어야 한다(부모가 무대라 퍼센트가 풀린다). 안쪽에만 두면
              // 부모 높이가 auto라 퍼센트가 정의되지 않아 아무 일도 안 난다.
              maxHeight: `calc(100% - ${SNAP_MARGIN * 2}px)`,
              top: "50%",
              translate: "0 -50%",
              marginTop: fit.railShift,
              transition:
                "margin-top .34s cubic-bezier(.22,.9,.24,1), top .34s cubic-bezier(.22,.9,.24,1)",
            }
          : {
              maxHeight: `calc(100% - ${SNAP_MARGIN * 2}px)`,
              top: fit.railMode === "top" ? SNAP_MARGIN : undefined,
              bottom: fit.railMode === "bottom" ? SNAP_MARGIN : undefined,
              translate: "0 0",
              marginTop: 0,
              transition:
                "margin-top .34s cubic-bezier(.22,.9,.24,1), top .34s cubic-bezier(.22,.9,.24,1)",
            }
      }
    >
      {isColorableTool(active) && (
        <Palette
          colors={colors}
          value={picked.value}
          onPick={picked.set}
          title={highlighting ? "형광펜 색" : "펜 색"}
        />
      )}
      <div
        data-no-pan
        /**
         * 화면보다 길어지면 **잘리지 말고 스크롤한다** (사용자 지시 2026-08-08의
         * 140% 배율에서 실제로 그랬다: 620px 화면에서 막대가 699px이라 위쪽이
         * -95px로 잘렸다).
         *
         * 버튼을 줄이거나 간격을 좁히는 길도 있지만, 그러면 "밀려난 버튼 위치는
         * 그대로"라는 약속이 깨진다. 자리는 그대로 두고 넘치는 만큼만 굴린다.
         */
        className="ui flex flex-col gap-1 rounded-xl border p-1.5"
        style={{
          // 바깥 막대가 정해 준 높이 안에서 굴린다. `min-height: 0`이 없으면
          // flex 자식은 내용만큼 늘어나 max-height를 무시한다.
          maxHeight: "100%",
          minHeight: 0,
          overflowY: "auto",
          background: "var(--c-raised)",
          borderColor: "var(--c-rule)",
          boxShadow: "var(--c-shadow-md)",
        }}
      >
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="도구 접기"
        title="도구 접기"
        className="mx-auto mb-0.5 flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--c-sunk)]"
        style={{ color: "var(--c-ink-faint)" }}
      >
        <X size={12} />
      </button>
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
              <Icon size={scaled(17)} strokeWidth={1.9} />
            </ToolButton>
          ))}
        </div>
      ))}

      {/* 실행 취소 버튼은 없다. Excalidraw가 undo/redo를 공개 API로 주지 않고
          (`history.clear()`만 있다) 합성 KeyboardEvent는 그 경로에 닿지 않는다
          — 실측으로 확인했다(진짜 키보드 Ctrl+Z는 요소 10→9로 동작, 합성
          이벤트는 무동작). 한동안 `⌘Z` 글자를 안내로 띄워 뒀는데 레일에
          기호만 덩그러니 떠 있어 지웠다(사용자 지시). 되돌리기는 그대로
          Ctrl/⌘+Z로 된다. */}
      </div>
    </div>
  );
}

/**
 * 색 고르개 (D150).
 *
 * 지금 켜진 도구에 맞는 목록만 보인다 — 펜을 들었을 때 형광펜 색을 보여
 * 주면 무엇에 적용되는지 알 수 없다. 지우개일 때는 아예 뜨지 않는다.
 */
function Palette({
  colors,
  value,
  onPick,
  title,
}: {
  colors: readonly { name: string; value: string }[];
  value: string;
  onPick: (v: string) => void;
  title: string;
}) {
  return (
    <div
      data-no-pan
      role="radiogroup"
      aria-label={title}
      className="ui flex flex-col gap-1 rounded-xl border p-1.5"
      style={{
        background: "var(--c-raised)",
        borderColor: "var(--c-rule)",
        boxShadow: "var(--c-shadow-md)",
      }}
    >
      {colors.map((c) => {
        const on = c.value === value;
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={c.name}
            title={`${title} — ${c.name}`}
                onClick={() => onPick(c.value)}
            className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors"
            style={{
                  background: on ? "var(--c-sunk)" : "transparent",
            }}
          >
            <span
              className="block rounded-full transition-all"
              style={{
                width: on ? 20 : 16,
                height: on ? 20 : 16,
                background: c.value,
                // 옅은 형광색은 흰 바탕에서 경계가 사라진다 — 얇은 테를 둘러
                // 어떤 색이든 원으로 보이게 한다.
                boxShadow: "inset 0 0 0 1px rgba(0,0,0,.18)",
              }}
            />
          </button>
        );
      })}
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
      /**
       * 크롬 배율 (사용자 지시 2026-08-08).
       *
       * ⚠️ 도구바에는 `zoom`을 못 건다. 이 막대는 `absolute`이고 자리를
       * `top: 50%`·`marginTop`(px)으로 잡는데, `zoom`은 퍼센트의 기준(무대)과
       * px 값을 서로 다르게 건드려 **계산이 통째로 어긋난다**. 크기만 키운다.
       */
      className="group relative flex items-center justify-center rounded-lg transition-colors"
      style={{
        width: scaled(36),
        height: scaled(36),
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
