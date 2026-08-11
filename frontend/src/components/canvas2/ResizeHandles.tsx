"use client";

/**
 * 글 상자의 크기 손잡이 (D142).
 *
 * 도형을 고르면 Excalidraw가 바운딩 박스와 손잡이를 보여 주는데, 우리 글
 * 상자만 안 그랬다. 같은 캔버스의 요소가 고를 때마다 다르게 굴면 학생은
 * 무엇을 할 수 있는지 매번 시험해 봐야 한다(사용자 지적).
 *
 * ## 크기를 바꾸지 글자를 키우지 않는다
 *
 * 대각선 손잡이도 **가로·세로 길이를 함께 바꿀 뿐**이다(사용자 지시). 도형처럼
 * 내용을 비율로 늘리면 글씨 크기가 아이템마다 달라져 캔버스가 읽기 어려워진다.
 * 폭이 바뀌면 글이 다시 흐를 뿐이고, 글자 크기는 어디서나 같다.
 *
 * ## 세로는 **최소** 높이다
 *
 * 글 상자는 내용이 차지하는 만큼이 자연 높이다. 그보다 작게 줄이면 글이
 * 잘리거나 넘쳐야 하는데, 캔버스에서 잘린 글은 사고다 — 학생이 쓴 것이 안
 * 보이는데 안 보인다는 사실조차 드러나지 않는다. 그래서 아래로 끌면 여백이
 * 늘고, 위로 끌면 **자연 높이에서 멈춘다.**
 *
 * ## 끄는 동안 React를 거치지 않는다
 *
 * 아이템 드래그와 같은 이유다(TextItem 헤더 참조) — 매 프레임 setState하면
 * 긴 문단에서 즉시 버벅인다. DOM style을 직접 고치고 손을 뗄 때 한 번 커밋한다.
 */

import { useCallback, useRef } from "react";
import { ITEM_MIN_W, ITEM_W } from "@/lib/canvas2/layout";
import { clampWidth } from "@/lib/canvas2/measureWidth";

/** 여덟 방향. 문자에 방위가 들어 있어 `includes`로 판정한다. */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const DIRS: readonly ResizeDir[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 이보다 낮으면 글이 한 줄도 안 보인다. */
const MIN_H = 28;

/** 손잡이 한 변(화면 px). 줌으로 나눠 **어느 배율에서나 같은 크기**로 보인다. */
const HANDLE_PX = 9;

/** 손잡이가 앉는 자리 — hover 박스(inset -12px -16px)의 변과 같다. */
const PAD_X = 16;
const PAD_Y = 12;

export interface ResizeCommit {
  w: number;
  h: number;
  /** 왼쪽·위 손잡이로 줄이면 원점이 움직인다. */
  dx: number;
  dy: number;
}

interface Props {
  zoom: number;
  /** 테두리·손잡이 색. 아이템의 출처 색을 그대로 쓴다. */
  color: string;
  /** 아이템 루트. 끄는 동안 이 요소의 style을 직접 고친다. */
  getEl: () => HTMLElement | null;
  onCommit: (next: ResizeCommit) => void;
  /** 크기를 되돌린다(자동 크기로). 손잡이 더블클릭. */
  onReset: () => void;
  /**
   * 넓힐 수 있는 한계 폭(world px) — **누를 때 한 번만** 잰다 (D210 3-2).
   *
   * 매 프레임 재면 복제·측정이 드래그마다 60번 돈다. 내용은 끄는 동안
   * 바뀌지 않으므로 한 번이면 충분하다.
   */
  maxW: () => number;
}

export function ResizeHandles({ zoom, color, getEl, onCommit, onReset, maxW }: Props) {
  const dragRef = useRef<{
    dir: ResizeDir;
    sx: number;
    sy: number;
    w: number;
    h: number;
    dx: number;
    dy: number;
    /** 이번 드래그의 한계 폭. 누를 때 한 번 잰다. */
    max: number;
  } | null>(null);

  const onDown = useCallback(
    (e: React.PointerEvent, dir: ResizeDir) => {
      if (e.button !== 0) return;
      const el = getEl();
      if (!el) return;
      // 아이템 드래그(TextItem)와 Excalidraw 양쪽으로 새지 않게 한다.
      e.stopPropagation();
      e.preventDefault();
      const r = el.getBoundingClientRect();
      dragRef.current = {
        dir,
        sx: e.clientX,
        sy: e.clientY,
        // 오버레이가 zoom으로 스케일돼 있다 — 화면 px을 world로 되돌린다.
        w: r.width / zoom,
        h: r.height / zoom,
        dx: 0,
        dy: 0,
        max: maxW(),
      };
      /**
       * CSS 상한을 **끄는 동안만** 푼다 (D210 3-2).
       *
       * 평소에는 `maxWidth: ITEM_W`가 읽기 폭을 지킨다. 그런데 그게 걸려
       * 있으면 손잡이를 아무리 끌어도 560에서 멈춘다 — 학생 눈에는 손잡이가
       * 고장난 것으로 보인다. 실제 한계는 JS가 잰 값이므로 여기서는 푼다.
       */
      el.style.maxWidth = "none";
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // 활성 포인터가 아니면 던진다. 캡처는 편의일 뿐이다.
      }
    },
    [getEl, zoom, maxW],
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      const el = getEl();
      if (!d || !el) return;
      const mx = (e.clientX - d.sx) / zoom;
      const my = (e.clientY - d.sy) / zoom;

      let w = d.w;
      let h = d.h;
      if (d.dir.includes("e")) w = d.w + mx;
      if (d.dir.includes("w")) w = d.w - mx;
      if (d.dir.includes("s")) h = d.h + my;
      if (d.dir.includes("n")) h = d.h - my;

      el.style.width = `${clampWidth(w, { min: ITEM_MIN_W, content: d.max, fallback: ITEM_W })}px`;
      el.style.minHeight = `${Math.max(MIN_H, h)}px`;

      /**
       * **실제 상자 크기를 되읽어 원점을 맞춘다.**
       *
       * 내용보다 낮게는 줄지 않으므로 요청한 h와 실제 높이가 다를 수 있다.
       * 요청값으로 원점을 옮기면 위쪽 손잡이가 상자에서 떨어져 나가 허공에
       * 뜬다 — 끌수록 벌어져서 무엇을 잡고 있는지 알 수 없게 된다.
       */
      const realW = el.offsetWidth;
      const realH = el.offsetHeight;
      d.dx = d.dir.includes("w") ? d.w - realW : 0;
      d.dy = d.dir.includes("n") ? d.h - realH : 0;
      el.style.transform = d.dx || d.dy ? `translate(${d.dx}px, ${d.dy}px)` : "";
    },
    [getEl, zoom],
  );

  const onUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    const el = getEl();
    if (!d || !el) return;
    // transform은 지우지 않는다 — 새 좌표가 오기 전에 지우면 한 프레임
    // 제자리로 돌아갔다 오면서 깜박인다(TextItem.settle이 정리한다).
    onCommit({ w: el.offsetWidth, h: el.offsetHeight, dx: d.dx, dy: d.dy });
  }, [getEl, onCommit]);

  const s = HANDLE_PX / zoom;
  /**
   * **손가락에 잡히는 자리는 보이는 점보다 넓다** (2026-08-10).
   *
   * 점은 9px이다. 마우스 커서는 한 점이라 그것으로 충분하지만 손가락 끝은
   * 약 44px이라 패드에서는 **크기 조절을 아예 못 한다** — 오버레이가 zoom으로
   * 스케일되므로 `/zoom`이 그 크기를 화면 9px에 고정한다(배율을 올려도
   * 손잡이는 안 커진다).
   *
   * 점을 키우면 카드를 덮는다. 그래서 **보이는 것은 그대로 두고 `::after`로
   * 잡히는 자리만** 넓힌다(globals.css의 `pointer: coarse` 블록). 그 값도
   * 화면 px으로 고정해야 하므로 여기서 나눠 내려보낸다 — CSS는 배율을 모른다.
   *
   * 이웃한 손잡이끼리는 겹친다(모서리와 변 가운데가 44px 안에 든다). 작은
   * 도판에서 'ne' 대신 'n'이 잡히는 일은 있지만 **아무것도 못 잡는 것보다
   * 낫다** — 어느 쪽이 잡혀도 크기는 조절된다.
   */
  const 잡는자리 = 44 / zoom;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      /**
       * 좌측 괘선보다 위에 있어야 한다.
       *
       * 괘선도 `left:-16`이라 서쪽 손잡이와 정확히 겹치는데, 뒤에 그려지는
       * 쪽이 이긴다 — 실측: 서쪽 손잡이를 끌면 크기가 아니라 **상자가
       * 이동했다**(x −70, 폭 그대로). 괘선이 먹은 pointerdown이 아이템
       * 드래그로 간 것이다.
       */
      style={
        {
          inset: `${-PAD_Y}px ${-PAD_X}px`,
          zIndex: 15,
          "--c2-handle-hit": `${잡는자리}px`,
        } as React.CSSProperties
      }
    >
      {DIRS.map((dir) => {
        const style: React.CSSProperties = {
          position: "absolute",
          width: s,
          height: s,
          marginLeft: -s / 2,
          marginTop: -s / 2,
          borderRadius: Math.max(1, 2 / zoom),
          background: "var(--c-raised)",
          border: `${Math.max(1, 1.5 / zoom)}px solid ${color}`,
          pointerEvents: "auto",
          cursor: cursorOf(dir),
          touchAction: "none",
        };
        // 변의 가운데 또는 꼭짓점.
        style.left = dir.includes("w") ? 0 : dir.includes("e") ? "100%" : "50%";
        style.top = dir.includes("n") ? 0 : dir.includes("s") ? "100%" : "50%";
        return (
          <div
            key={dir}
            data-no-pan
            data-resize-handle={dir}
            style={style}
            onPointerDown={(e) => onDown(e, dir)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onReset();
            }}
            title="끌어서 크기 조절 · 더블클릭하면 자동 크기로"
          />
        );
      })}
    </div>
  );
}

function cursorOf(dir: ResizeDir): string {
  if (dir === "n" || dir === "s") return "ns-resize";
  if (dir === "e" || dir === "w") return "ew-resize";
  return dir === "ne" || dir === "sw" ? "nesw-resize" : "nwse-resize";
}
