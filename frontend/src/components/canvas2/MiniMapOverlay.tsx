"use client";

/**
 * 캔버스 위에 뜨는 미니맵 (D210 5-1·5-2).
 *
 * ## 왜 페이지가 아니라 오버레이인가
 *
 * D205에서 지도를 별도 페이지로 뺐다. 캔버스가 넓어진 것은 얻었지만 **이동
 * 자체가 불편하다**는 의견이 왔다(사용자 2026-08-08) — 지도를 잠깐 보려고
 * 화면을 통째로 바꾸는 것은 값이 크다. 이제 버튼을 누르면 그 자리에 뜬다.
 *
 * 지도 그리기는 `SessionMap` 하나가 맡는다 — 오버레이·팝업·페이지가 같은
 * 컴포넌트를 쓰므로 셋이 갈라지지 않는다.
 *
 * ## 자유 위치가 없다
 *
 * 끌어 옮길 수 있지만 손을 떼면 **가장 가까운 모서리로 붙는다**(`cornerSnap`).
 * 자유롭게 두면 미니맵이 한가운데 떠서 정작 캔버스를 가린다. 붙은 모서리는
 * 기억한다 — 매번 기본 자리로 돌아가면 옮긴 의미가 없다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, X } from "lucide-react";
import { SessionMap } from "./SessionMap";
import type { CanvasItem } from "@/lib/canvas2/types";
import type { Size } from "@/lib/canvas2/useItemLayout";
import { cornerPos, nearestCorner, type Corner } from "@/lib/canvas2/cornerSnap";

/**
 * 미니맵 상자 크기(px). 캔버스를 가리지 않는 선.
 *
 * 340×260이었다. 0.8배로 줄였다(사용자 지시 2026-08-08) — 캔버스 위에 늘
 * 떠 있는 것이라 작을수록 좋고, 자세히 볼 때는 팝업이 있다.
 */
const MINI = { w: 272, h: 208 };
/** 팝업은 뷰포트의 이 비율까지만 — 뒤쪽 캔버스가 테두리처럼 보여야 한다. */
const POPUP_RATIO = 0.78;
const POPUP_MAX = { w: 1200, h: 800 };
/** 붙은 모서리를 기억하는 키. */
const CORNER_KEY = "nodi.map.corner";

function loadCorner(): Corner {
  if (typeof window === "undefined") return "br";
  const v = window.localStorage.getItem(CORNER_KEY);
  // 좌상단은 더 이상 허용하지 않는다(D211 9) — 예전에 거기 두었던 학생도
  // 다음에 열면 오른쪽 아래에서 시작한다.
  return v === "tr" || v === "bl" || v === "br" ? v : "br";
}

interface Props {
  items: CanvasItem[];
  positions: Map<string, { x: number; y: number }>;
  sizes: Map<string, Size>;
  tagOrder: readonly string[];
  open: boolean;
  onClose: () => void;
  /** 붙은 모서리가 바뀌었다 — 도구바가 비켜설 수 있게 알린다 (D211 9). */
  onCornerChange?: (corner: Corner) => void;
  onOpenNode: (itemId: string) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
}

export function MiniMapOverlay({
  items,
  positions,
  sizes,
  tagOrder,
  open,
  onClose,
  onOpenNode,
  onMoveNode,
  onCornerChange,
}: Props) {
  /**
   * 첫 값을 **렌더에서 바로 읽는다** (게으른 초기값).
   *
   * 이 컴포넌트는 학생이 지도를 열었을 때만 그려진다 — 서버 렌더에서는
   * `open`이 거짓이라 아무것도 안 나온다. 그러니 hydration이 어긋날 자리가
   * 없고, 이펙트에서 setState를 부를 이유도 없다(React Compiler가 막는다).
   */
  const [corner, setCorner] = useState<Corner>(loadCorner);
  const [big, setBig] = useState(false);
  /**
   * 잣대는 **창이 아니라 캔버스 무대**다.
   *
   * 미니맵은 `absolute`라 자리를 무대(`.canvas2`) 기준으로 잡는데, 창 크기로
   * 모서리를 계산하면 그 차이만큼 어긋난다 — 왼쪽 도구 사이드바(64px)가 있어서
   * 오른쪽 아래로 붙이면 **화면 밖으로 48px 나갔다**(실측 2026-08-08: 상자
   * 오른쪽 끝 1488 > 창 1440). 무대 자체를 재면 이 문제가 성립하지 않고,
   * 사이드바 폭이 바뀌어도 따라간다.
   *
   * 재는 자리는 **ref 콜백**이다 — 이펙트 본문의 setState는 React Compiler가
   * 막는다. `ResizeObserver`가 처음 한 번도 불러 주므로 초기값도 여기서 온다.
   */
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const obsRef = useRef<ResizeObserver | null>(null);
  /** 끄는 중의 자리. React를 거치지 않고 DOM만 민다. */
  const dragRef = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);

  const attach = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el;
    obsRef.current?.disconnect();
    obsRef.current = null;
    const host = el?.offsetParent as HTMLElement | null;
    if (!host) return;
    const read = () => {
      const r = host.getBoundingClientRect();
      const next = { w: Math.round(r.width), h: Math.round(r.height) };
      setFrame((prev) => (prev && prev.w === next.w && prev.h === next.h ? prev : next));
    };
    const ro = new ResizeObserver(read);
    ro.observe(host);
    obsRef.current = ro;
  }, []);

  useEffect(() => () => obsRef.current?.disconnect(), []);

  /**
   * 열릴 때도 지금 모서리를 알린다 (D211 9).
   *
   * 끌어 옮길 때만 알리면, 저장된 자리가 우상단인 학생은 **열자마자 겹친
   * 화면**을 본다 — 한 번 끌어야 비켜서는 셈이다.
   */
  useEffect(() => {
    if (open) onCornerChange?.(corner);
  }, [open, corner, onCornerChange]);

  /** 아직 못 쟀으면 교실 노트북 기본값 — 한 프레임뿐이고 그동안은 숨어 있다. */
  const vp = useMemo(() => frame ?? { w: 1440, h: 900 }, [frame]);

  /** Esc로 닫는다 — 팝업이면 팝업만, 아니면 미니맵을 닫는다. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (big) setBig(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [open, big, onClose]);

  const at = cornerPos(corner, vp, MINI);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const t = e.target as HTMLElement;
      /**
       * 손잡이 안의 **버튼은 손잡이가 아니다**. 크게 보기·닫기 버튼이
       * `[data-map-grab]` 안에 있어서, 안 걸러 내면 누르는 순간 드래그가
       * 시작되고 `setPointerCapture`가 포인터를 상자로 가져간다 — click이
       * 버튼에 닿지 못해 **눌러도 아무 일이 없다**(실측 2026-08-08: 팝업이
       * 안 열렸다). 눈에는 멀쩡한 버튼이라 더 안 보인다.
       */
      if (t.closest("button")) return;
      // 지도 안(노드)에서 시작한 것은 지도의 일이다.
      if (t.closest("[data-map-grab]") === null) return;
      /**
       * 출발점은 **지금 화면에 있는 자리**다 (D211 8).
       *
       * state에서 계산한 `at`을 쓰면, 앞 드래그의 인라인 값이 남아 있거나
       * 전이가 도는 중일 때 실제 자리와 어긋난다 — 잡는 순간 상자가 튄다.
       */
      const box = e.currentTarget as HTMLElement;
      const host = box.offsetParent as HTMLElement | null;
      const br = box.getBoundingClientRect();
      const hr = host?.getBoundingClientRect();
      dragRef.current = {
        sx: e.clientX,
        sy: e.clientY,
        x: hr ? br.x - hr.x : at.x,
        y: hr ? br.y - hr.y : at.y,
      };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [at.x, at.y],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = boxRef.current;
    if (!d || !el) return;
    el.style.transition = "none";
    el.style.left = `${d.x + (e.clientX - d.sx)}px`;
    el.style.top = `${d.y + (e.clientY - d.sy)}px`;
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      const el = boxRef.current;
      if (!d || !el) return;
      const next = nearestCorner(
        { x: d.x + (e.clientX - d.sx), y: d.y + (e.clientY - d.sy) },
        vp,
        MINI,
      );
      /**
       * ⚠️ **인라인 좌표를 지우면 안 된다** (D211 8, 사용자 보고 2026-08-08).
       *
       * 지우면 React가 다시 그릴 때까지 `left/top`이 비어, 상자가 컨테이너
       * 원점(좌상단)으로 튄다. 그리고 스냅 결과가 **지금 모서리와 같으면**
       * `setCorner`가 같은 값이라 React가 아예 다시 그리지 않는다 — 그래서
       * "우측 상단에 놓았는데 좌측 상단으로 갔다"가 됐고, 다음에 잡으면
       * state의 자리로 돌아와 "아까 안 갔던 곳에 있다"가 됐다.
       *
       * 목표 좌표를 **직접 쓴다.** React의 인라인 값과 같아지므로 다시 그리든
       * 안 그리든 자리가 같다.
       */
      const at2 = cornerPos(next, vp, MINI);
      el.style.transition = "";
      el.style.left = `${at2.x}px`;
      el.style.top = `${at2.y}px`;
      setCorner(next);
      window.localStorage.setItem(CORNER_KEY, next);
      onCornerChange?.(next);
    },
    [vp, onCornerChange],
  );

  if (!open) return null;

  const popup = {
    w: Math.min(POPUP_MAX.w, Math.round(vp.w * POPUP_RATIO)),
    h: Math.min(POPUP_MAX.h, Math.round(vp.h * POPUP_RATIO)),
  };

  const 지도 = (box: { w: number; h: number }) => (
    <SessionMap
      items={items}
      positions={positions}
      sizes={sizes}
      tagOrder={tagOrder}
      box={{ w: box.w, h: box.h - 30 }}
      compact={box.w <= MINI.w}
      onOpen={onOpenNode}
      onMoveNode={onMoveNode}
    />
  );

  return (
    <>
      <div
        ref={attach}
        data-no-pan
        // 도구바가 이 상자를 피해 비켜선다 (D211 9).
        data-minimap
        className="canvas2 ui absolute z-30 overflow-hidden rounded-xl"
        style={{
          // 무대를 재기 전 한 프레임은 숨긴다 — 안 그러면 열자마자 옆으로 미끄러진다.
          visibility: frame ? "visible" : "hidden",
          left: at.x,
          top: at.y,
          width: MINI.w,
          height: MINI.h,
          background: "var(--c-paper)",
          border: "3px solid var(--accent-border)",
          boxShadow: "var(--c-shadow-lg)",
          // 모서리로 붙는 움직임 — 즉시 튀면 어디로 갔는지 안 보인다.
          transition: "left .28s cubic-bezier(.16,1,.3,1), top .28s cubic-bezier(.16,1,.3,1)",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* 손잡이 — 여기서만 끌린다. 지도 안에서 끌면 지도가 움직여야 한다. */}
        <div
          data-map-grab
          className="flex items-center justify-between px-2"
          style={{
            paddingTop: 2,
            paddingBottom: 2,
            cursor: "grab",
            borderBottom: "1px solid var(--c-rule)",
          }}
        >
          <span className="label text-[11px]" style={{ color: "var(--c-ink-soft)" }}>
            지도
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              aria-label="지도 크게 보기"
              title="크게 보기"
              onClick={() => setBig(true)}
              className="rounded p-1"
              style={{ color: "var(--c-ink-soft)" }}
            >
              <Maximize2 size={13} />
            </button>
            <button
              type="button"
              aria-label="지도 닫기"
              onClick={onClose}
              className="rounded p-1"
              style={{ color: "var(--c-ink-soft)" }}
            >
              <X size={13} />
            </button>
          </span>
        </div>
        {지도(MINI)}
      </div>

      {/**
       * 팝업 (D210 5-2) — **같은 화면 위의 모달**이다. 페이지 이동은 딜레이가
       * 생기는데 그게 원래 불만이었다. 화면을 꽉 채우지 않아 뒤쪽 캔버스가
       * 테두리처럼 보인다 — "닫으면 돌아간다"가 그래야 읽힌다.
       */}
      {big && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center"
          style={{ background: "var(--c-overlay)" }}
          // 바깥을 누르면 닫힌다.
          onClick={() => setBig(false)}
        >
          <div
            className="canvas2 overflow-hidden rounded-2xl"
            style={{
              width: popup.w,
              height: popup.h,
              background: "var(--c-paper)",
              border: "5px solid var(--accent-border)",
              boxShadow: "var(--c-shadow-lg)",
              animation: "c2-map-pop .18s cubic-bezier(.16,1,.3,1) both",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-3 py-1.5"
              style={{ borderBottom: "1px solid var(--c-rule)" }}
            >
              <span className="label text-[12px]" style={{ color: "var(--c-ink-soft)" }}>
                대화방 지도
              </span>
              <button
                type="button"
                aria-label="지도 팝업 닫기"
                onClick={() => setBig(false)}
                className="rounded p-1"
                style={{ color: "var(--c-ink-soft)" }}
              >
                <X size={15} />
              </button>
            </div>
            {지도({ w: popup.w, h: popup.h - 6 })}
          </div>
        </div>
      )}
    </>
  );
}
