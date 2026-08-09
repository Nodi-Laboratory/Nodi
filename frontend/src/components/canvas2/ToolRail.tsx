"use client";

/**
 * 우측 세로 도구 레일 (D120).
 *
 * Excalidraw 기본 툴바를 끄고 이걸 쓴다. 단축키는 Excalidraw와 **같게** 둔다 —
 * 다른 그리기 도구를 써 본 학생이 손에 익은 키를 그대로 쓸 수 있게.
 *
 * ## 짧다 (사용자 지시 2026-08-09)
 *
 * 도구가 열둘까지 늘어 막대가 화면 세로를 다 먹었다. **비슷한 것을 접어**
 * 다섯 줄로 줄인다:
 *
 *   [선택·이동]  하나로 합쳤다. 그냥 끌면 화면 이동, **0.7초 누르고** 끌면
 *                선택 상자다(`useTouchNavigate`). 손가락에서 쓰던 규칙을
 *                마우스로 옮겨 온 것이다(D208).
 *   [카드 수정]  그대로.
 *   [펜]         눌러서 편다 — 연필 · 형광펜 · 텍스트.
 *   [도형]       눌러서 편다 — 네모 · 세모 · 별 · 원 · 화살표 · 선.
 *   [색]         무지개 원. 눌러서 편다 — 고른 색은 **모든 그리기 도구**에 쓴다.
 *   [지우개]     그대로.
 *
 * 질문하는 펜은 레일에서 **뺐다**(사용자 지시) — 하단 입력창 왼쪽의 토글이
 * 그 자리를 대신한다. 자판으로 물을지 손으로 써서 물을지는 "무엇을 그릴까"가
 * 아니라 "어떻게 물을까"라, 그리기 도구들과 같은 자리에 있을 것이 아니었다.
 *
 * ⚠️ **접는 것은 화면뿐이다.** 단축키는 접힌 도구까지 전부 그대로 듣는다 —
 * 손에 익은 키가 어느 날 안 먹으면 그건 고장으로 읽힌다.
 */

import {
  ArrowUpRight,
  ChevronLeft,
  Circle,
  Eraser,
  Highlighter,
  Minus,
  MousePointer2,
  Pencil,
  Shuffle,
  Square,
  Star,
  Triangle,
  Type,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
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

/**
 * 펼쳐서 고르는 묶음.
 *
 * 묶음 버튼의 아이콘은 **고정**이다(사용자 지시: 도형은 네모, 펜은 펜). 지금
 * 켜진 도구를 아이콘으로 보여 주면 버튼이 매번 다른 그림이 되어 "여기를
 * 누르면 도형이 나온다"는 자리 기억이 안 생긴다.
 */
const PEN_GROUP: ToolDef[] = [
  { tool: "freedraw", icon: Pencil, label: "자유선", key: "p" },
  // `d`는 Excalidraw에서 마름모라 쓰지 않는다. `m`은 marker.
  { tool: "highlighter", icon: Highlighter, label: "형광펜", key: "m" },
  { tool: "note", icon: Type, label: "글 쓰기", key: "t" },
];

const SHAPE_GROUP: ToolDef[] = [
  { tool: "rectangle", icon: Square, label: "네모", key: "r" },
  { tool: "triangle", icon: Triangle, label: "세모", key: "g" },
  { tool: "star", icon: Star, label: "별", key: "k" },
  // 원은 하루 뺐다가 되돌렸다(사용자 지시 2026-08-10). 키(`o`)는 그동안에도
  // 그대로 들었다 — 화면에서 사라진 것과 기능이 사라진 것은 다르다.
  { tool: "ellipse", icon: Circle, label: "원", key: "o" },
  { tool: "arrow", icon: ArrowUpRight, label: "화살표", key: "a" },
  { tool: "line", icon: Minus, label: "선", key: "l" },
];

/** 묶이지 않은 도구들 — 레일에 자기 줄이 있다. */
const SOLO_TOOLS: ToolDef[] = [
  /**
   * 선택과 화면 이동을 **하나로 합쳤다** (사용자 지시 2026-08-09).
   *
   * 도구 이름은 `hand`(화면 이동) 그대로다 — 끌기의 기본 뜻이 화면 이동이고,
   * 선택 상자는 0.7초 눌렀을 때만 나온다. 아이콘만 선택 화살표다: 학생이
   * 이 버튼에서 기대하는 것은 "평소 상태"이지 "손바닥"이 아니다.
   */
  { tool: "hand", icon: MousePointer2, label: "선택·이동", key: "v" },
  /** 카드 수정 (D180) — 관계를 손으로 다시 엮는다. 아이콘은 사용자 지정. */
  { tool: "cardedit", icon: Shuffle, label: "카드 수정", key: "s" },
  { tool: "eraser", icon: Eraser, label: "지우개", key: "e" },
];

/** 단축키가 듣는 전부. 화면에 접혀 있어도 키는 그대로다. */
const ALL = [...SOLO_TOOLS, ...PEN_GROUP, ...SHAPE_GROUP];

/**
 * 색 (D150 → 사용자 지시 2026-08-09로 **한 벌**이 됐다).
 *
 * 값은 Excalidraw가 쓰는 open-color 계열 그대로다 — 우리가 임의로 고르면
 * 같은 캔버스 위에서 저쪽 기본 색과 톤이 어긋난다.
 *
 * 예전에는 펜용·형광펜용 두 벌이었다. 이제 **한 벌을 모든 그리기 도구가**
 * 쓴다(연필·형광펜·도형·선). 형광펜은 같은 색을 투명도 40으로 칠하므로
 * 진한 색을 골라도 형광펜처럼 보인다 — 색을 두 벌로 나눌 이유가 없었다.
 */
const COLORS = [
  { name: "먹", value: "#1e1e1e" },
  { name: "빨강", value: "#e03131" },
  { name: "주황", value: "#f08c00" },
  { name: "노랑", value: "#f5c518" },
  { name: "초록", value: "#2f9e44" },
  { name: "파랑", value: "#1971c2" },
  { name: "보라", value: "#7048e8" },
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

/** 지금 펼쳐 둔 묶음. null이면 아무것도 안 펼쳤다. */
type OpenGroup = "pen" | "shape" | "color" | null;

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
  mapCorner = null,
  active,
  onSelect,
  setDrawStyle,
  paused = false,
}: Props) {
  const [fitRef, fit] = useChromeFit(mapCorner);
  const color = useStickyChoice(
    "draw.color",
    COLORS.map((c) => c.value),
    COLORS[0].value,
  );
  const [openGroup, setOpenGroup] = useState<OpenGroup>(null);
  const highlighting = active === "highlighter";

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
    setDrawStyle({ strokeColor: color.value, ...s });
  }, [active, highlighting, color.value, setDrawStyle]);

  /**
   * 접었다 펼 수 있다 (D140, 사용자 지시). 접으면 **지금 켜진 도구 하나만**
   * 남는다 — 무엇이 선택돼 있는지는 접어 둬도 알아야 한다.
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

  const pick = (tool: ToolName) => {
    onSelect(tool);
    setOpenGroup(null);
  };
  const toggleGroup = (g: Exclude<OpenGroup, null>) =>
    setOpenGroup((prev) => (prev === g ? null : g));

  return (
    // 오른쪽 **아래** — 사용자 지시. 하단 입력창은 가운데라 부딪히지 않는다.
    // 펼친 묶음은 레일 **왼쪽**에 붙인다. 레일 안에 넣으면 세로로 길어져
    // 좁은 화면(교실 태블릿)에서 상단바까지 닿는다 — 짧게 만든 뜻이 사라진다.
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
       */
      style={
        fit.railMode === "center"
          ? {
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
      {openGroup === "color" ? (
        <Palette colors={COLORS} value={color.value} onPick={color.set} />
      ) : openGroup ? (
        <Flyout
          tools={openGroup === "pen" ? PEN_GROUP : SHAPE_GROUP}
          active={active}
          onPick={pick}
        />
      ) : null}

      <div
        data-no-pan
        className="ui flex flex-col gap-1 rounded-xl border p-1.5"
        style={{
          /**
           * ⚠️ **`max-height: 100%`로는 안 잡힌다.** 바깥 막대의 높이는 auto
           * (내용이 정한다)라 퍼센트가 **정의되지 않는다**. `align-self:
           * stretch`는 상한에 걸려 확정된 막대 높이를 그대로 받는다 — 그제야
           * 안쪽 스크롤이 뜻을 갖는다(2026-08-09 실측: 접기 버튼이 무대 밖으로
           * 밀려 안 눌렸다).
           */
          alignSelf: "stretch",
          minHeight: 0,
          background: "var(--c-raised)",
          borderColor: "var(--c-rule)",
          boxShadow: "var(--c-shadow-md)",
        }}
      >
        {/* ⚠️ 접기 버튼은 **안 굴러간다** — 막대가 화면보다 길 때 치우고 싶은
            법인데, 스크롤에 함께 실으면 그때 이 버튼이 상자 밖으로 나간다. */}
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="도구 접기"
          title="도구 접기"
          className="mx-auto mb-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--c-sunk)]"
          style={{ color: "var(--c-ink-faint)" }}
        >
          <X size={12} />
        </button>

        <div
          className="flex flex-col gap-1"
          style={{ minHeight: 0, overflowY: "auto", overflowX: "hidden" }}
        >
          {/* 선택·이동 */}
          <ToolButton
            active={active === "hand" || active === "selection"}
            label={SOLO_TOOLS[0].label}
            hint="V"
            onClick={() => pick("hand")}
            accent="neutral"
          >
            <MousePointer2 size={scaled(17)} strokeWidth={1.9} />
          </ToolButton>

          <Rule />

          {/* 카드 수정 */}
          <ToolButton
            active={active === "cardedit"}
            label={SOLO_TOOLS[1].label}
            hint="S"
            onClick={() => pick("cardedit")}
            accent="hand"
          >
            <Shuffle size={scaled(17)} strokeWidth={1.9} />
          </ToolButton>

          <Rule />

          {/* 펜 묶음 — 연필 · 형광펜 · 텍스트 */}
          <ToolButton
            active={PEN_GROUP.some((d) => d.tool === active)}
            label="펜"
            hint="P"
            expanded={openGroup === "pen"}
            onClick={() => toggleGroup("pen")}
            accent="hand"
          >
            <Pencil size={scaled(17)} strokeWidth={1.9} />
          </ToolButton>

          {/* 도형 묶음 — 네모 · 세모 · 별 · 화살표 · 선 */}
          <ToolButton
            active={SHAPE_GROUP.some((d) => d.tool === active)}
            label="도형"
            hint="R"
            expanded={openGroup === "shape"}
            onClick={() => toggleGroup("shape")}
            accent="hand"
          >
            <Square size={scaled(17)} strokeWidth={1.9} />
          </ToolButton>

          {/* 색 — 고른 색은 **모든 그리기 도구**에 쓴다(사용자 지시). */}
          <ToolButton
            active={openGroup === "color"}
            label="색"
            hint=""
            expanded={openGroup === "color"}
            onClick={() => toggleGroup("color")}
            accent="neutral"
          >
            <ColorDot value={color.value} />
          </ToolButton>

          <Rule />

          <ToolButton
            active={active === "eraser"}
            label="지우개"
            hint="E"
            onClick={() => pick("eraser")}
            accent="hand"
          >
            <Eraser size={scaled(17)} strokeWidth={1.9} />
          </ToolButton>

          {/* 실행 취소 버튼은 없다. Excalidraw가 undo/redo를 공개 API로 주지
              않고(`history.clear()`만 있다) 합성 KeyboardEvent는 그 경로에 닿지
              않는다 — 되돌리기는 그대로 Ctrl/⌘+Z로 된다. */}
        </div>
      </div>
    </div>
  );
}

function Rule() {
  return <div className="mx-1.5 my-0.5 h-px shrink-0" style={{ background: "var(--c-rule)" }} />;
}

/**
 * 색 단추의 그림 — **무지개 원** (사용자 지시 2026-08-09).
 *
 * 가운데에 지금 고른 색을 박는다. 무지개만 있으면 "색을 고르는 곳"인 것은
 * 알아도 **지금 무슨 색인지**는 팔레트를 열어야만 알 수 있다.
 */
function ColorDot({ value }: { value: string }) {
  const d = scaled(17);
  return (
    <span
      className="relative block rounded-full"
      style={{
        width: d,
        height: d,
        background:
          "conic-gradient(#e03131, #f08c00, #f5c518, #2f9e44, #1971c2, #7048e8, #e03131)",
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,.15)",
      }}
    >
      <span
        className="absolute rounded-full"
        style={{
          inset: d * 0.28,
          background: value,
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,.7)",
        }}
      />
    </span>
  );
}

/**
 * 펼친 묶음 (사용자 지시 2026-08-09).
 *
 * 팔레트와 **같은 자리·같은 생김새**로 왼쪽에 붙는다 — 레일에서 펼쳐지는
 * 것은 전부 여기서 나온다는 규칙 하나면 학생이 두 번 배우지 않는다.
 */
function Flyout({
  tools,
  active,
  onPick,
}: {
  tools: readonly ToolDef[];
  active: ToolName;
  onPick: (t: ToolName) => void;
}) {
  return (
    <div
      data-no-pan
      data-tool-flyout
      role="group"
      className="ui flex flex-col gap-1 rounded-xl border p-1.5"
      style={{
        background: "var(--c-raised)",
        borderColor: "var(--c-rule)",
        boxShadow: "var(--c-shadow-md)",
      }}
    >
      {tools.map(({ tool, icon: Icon, label, key }) => (
        <ToolButton
          key={tool}
          active={active === tool}
          label={label}
          hint={key.toUpperCase()}
          onClick={() => onPick(tool)}
          accent="hand"
        >
          <Icon size={scaled(17)} strokeWidth={1.9} />
        </ToolButton>
      ))}
    </div>
  );
}

/**
 * 색 고르개 (D150 → 2026-08-09로 **한 벌**).
 *
 * 예전에는 켜진 도구에 맞는 목록만 보였다(펜 색 / 형광펜 색). 이제 색은
 * 도구와 따로 고르는 것이라 언제나 같은 목록이다 — 도구를 바꿔도 색은 그대로
 * 라는 뜻이고, 그게 필기구를 바꿔 쥐는 일과 같다.
 */
function Palette({
  colors,
  value,
  onPick,
}: {
  colors: readonly { name: string; value: string }[];
  value: string;
  onPick: (v: string) => void;
}) {
  return (
    <div
      data-no-pan
      data-color-palette
      role="radiogroup"
      aria-label="그리기 색"
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
            title={`그리기 색 — ${c.name}`}
            onClick={() => onPick(c.value)}
            className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors"
            style={{ background: on ? "var(--c-sunk)" : "transparent" }}
          >
            <span
              className="block rounded-full transition-all"
              style={{
                width: on ? 20 : 16,
                height: on ? 20 : 16,
                background: c.value,
                // 옅은 색은 흰 바탕에서 경계가 사라진다 — 얇은 테를 둘러
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
  expanded,
  children,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
  accent: "neutral" | "hand";
  /** 묶음 단추인가 — 펼쳐져 있으면 화살표를 보여 준다. */
  expanded?: boolean;
  children: React.ReactNode;
}) {
  const on = accent === "hand" ? "var(--c-hand)" : "var(--c-ink)";
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint ? `${label} (${hint})` : label}
      aria-label={label}
      aria-pressed={active}
      aria-expanded={expanded}
      /**
       * 크롬 배율 (사용자 지시 2026-08-08).
       *
       * ⚠️ 도구바에는 `zoom`을 못 건다. 이 막대는 `absolute`이고 자리를
       * `top: 50%`·`marginTop`(px)으로 잡는데, `zoom`은 퍼센트의 기준(무대)과
       * px 값을 서로 다르게 건드려 **계산이 통째로 어긋난다**. 크기만 키운다.
       */
      className="group relative flex shrink-0 items-center justify-center rounded-lg transition-colors"
      style={{
        width: scaled(36),
        height: scaled(36),
        background: active
          ? accent === "hand"
            ? "var(--c-hand-wash)"
            : "var(--c-sunk)"
          : "transparent",
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
      {/* 펼치는 단추라는 표시 — 모서리의 작은 삼각형. 눌러 봐야 아는 것보다 낫다. */}
      {expanded !== undefined && (
        <span
          aria-hidden
          className="absolute bottom-0.5 left-0.5 h-0 w-0"
          style={{
            borderLeft: "4px solid transparent",
            borderBottom: `4px solid ${active ? on : "var(--c-ink-faint)"}`,
          }}
        />
      )}
      {/* 단축키는 hover에만. 평소에 다 보이면 레일이 시끄럽다 */}
      <span
        className="label pointer-events-none absolute right-full mr-2 whitespace-nowrap rounded px-1.5 py-1 opacity-0 transition-opacity group-hover:opacity-100"
        style={{ background: "var(--c-ink)", color: "var(--c-paper)" }}
      >
        {label} {hint && <span style={{ opacity: 0.55 }}>{hint}</span>}
      </span>
    </button>
  );
}
