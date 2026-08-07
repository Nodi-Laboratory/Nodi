"use client";

/**
 * 끄는 동안 배경 카드가 비켜 주게 한다 (D207).
 *
 * ## 왜 `dragBus`를 구독하는가
 *
 * 드래그는 **React를 거치지 않는다**(D124·D147) — 아이템이 DOM transform으로
 * 직접 움직인다. 그 이동량은 이미 `dragBus`로 흐르고 있으므로(연결선이 그걸
 * 쓴다) 여기서 한 번 더 구독하면 드래그 훅을 건드리지 않고 끼어들 수 있다.
 * 밀려나는 카드도 같은 방식으로 DOM만 고친다 — 60fps로 setState하면 카드가
 * 많은 캔버스에서 즉시 버벅인다.
 *
 * ## 언제 확정하나
 *
 * `dragBus`가 **빈 맵**을 보내면 손을 뗀 것이다. 그 순간 마지막으로 계산한
 * 밀림을 좌표로 저장한다(사용자 지시: "밀려난 상태로 드래그를 끝내면 그
 * 위치에 겹침없이 놓이게 된다"). 끄는 카드가 멀어져 밀림이 사라진 채로
 * 끝났다면 저장할 것이 없다 — 밀렸던 카드는 이미 제자리로 돌아가 있다.
 *
 * ## 왜 transition을 쓰나
 *
 * 되돌아오는 움직임까지 손으로 그리면 rAF 루프가 하나 더 생긴다. 밀림은
 * 목표 좌표가 매 프레임 새로 정해지는 값이라, CSS transition에 맡기면
 * 브라우저가 알아서 그 사이를 채운다 — 카드가 "스르르" 비키고 돌아온다.
 */

import { useEffect, useRef } from "react";
import { subscribeDrag, type DragOffset } from "./dragBus";
import { pushAway, type Displacement, type PushCandidate } from "./pushAway";
import type { Rect } from "./rect";

export interface CardPushArgs {
  /** 지금 캔버스에 있는 모든 카드의 자리. 밀 대상이자 장애물이다. */
  rectsOf: () => Map<string, Rect>;
  /** 밀린 자리를 좌표로 확정한다. */
  commit: (moves: readonly { id: string; x: number; y: number }[]) => void;
  gap: number;
  strength: number;
  speedMs: number;
  /** 꺼져 있으면 아무 일도 하지 않는다(강도 0과 같다). */
  enabled?: boolean;
}

/** 밀린 카드에만 붙이는 표시 — 정리할 때 이것만 훑는다. */
const MARK = "data-pushed";

function elOf(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-canvas-item="${CSS.escape(id)}"]`,
  );
}

export function useCardPush({
  rectsOf,
  commit,
  gap,
  strength,
  speedMs,
  enabled = true,
}: CardPushArgs): void {
  /**
   * 콜백과 값을 ref에 담아 **구독을 다시 걸지 않는다.**
   *
   * deps에 넣으면 카드가 하나 늘 때마다 구독이 해지·재등록된다. 드래그
   * 도중에 그 일이 일어나면 밀림이 한 프레임 끊긴다.
   */
  const argsRef = useRef({ rectsOf, commit, gap, strength, speedMs, enabled });
  // 렌더 중에 ref를 쓰면 React Compiler가 막는다 — 이펙트에서 맞춘다.
  useEffect(() => {
    argsRef.current = { rectsOf, commit, gap, strength, speedMs, enabled };
  }, [commit, enabled, gap, rectsOf, speedMs, strength]);

  /** 마지막으로 계산한 밀림. 손을 뗄 때 이것을 좌표로 확정한다. */
  const pushedRef = useRef<Map<string, Displacement>>(new Map());
  /**
   * 이번 드래그의 카드 자리 — **한 번만 잰다.**
   *
   * 끄는 동안 다른 카드의 좌표는 바뀌지 않는다(밀림은 transform이고 좌표는
   * 손을 뗄 때 확정된다). 그런데 매 프레임 `rectsOf()`를 부르면 카드 수만큼
   * 객체를 새로 만들어 Map에 넣는 일이 초당 60번 돈다 — 계산보다 이쪽이
   * 비쌌다.
   */
  const baseRef = useRef<Map<string, Rect> | null>(null);
  /** 요소 조회 캐시. `querySelector`를 프레임마다 부르지 않는다. */
  const elCacheRef = useRef<Map<string, HTMLElement | null>>(new Map());
  /** transition을 이미 건 요소. 매 프레임 다시 쓰면 스타일 재계산이 돈다. */
  const easedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    /** 화면에서 밀림을 걷어낸다. 손을 뗀 뒤·확정 뒤에 부른다. */
    const clearMarks = (instant: boolean) => {
      for (const el of document.querySelectorAll<HTMLElement>(`[${MARK}]`)) {
        if (instant) el.style.transition = "none";
        el.style.transform = "";
        el.removeAttribute(MARK);
        if (instant) {
          void el.offsetHeight; // transition:none을 이 프레임에 확정
          el.style.transition = "";
        }
      }
    };

    /** 이번 드래그 동안만 유효한 요소 조회. */
    const el = (id: string): HTMLElement | null => {
      const cache = elCacheRef.current;
      if (cache.has(id)) return cache.get(id) ?? null;
      const found = elOf(id);
      cache.set(id, found);
      return found;
    };

    /** 드래그가 끝났다 — 이번 판의 캐시를 버린다. */
    const endDrag = () => {
      baseRef.current = null;
      elCacheRef.current = new Map();
      easedRef.current = new Set();
    };

    const apply = (moving: ReadonlyMap<string, DragOffset>) => {
      const a = argsRef.current;

      // ── 손을 뗐다 ──────────────────────────────────────────────────
      if (!moving.size) {
        const pushed = pushedRef.current;
        const base = baseRef.current;
        if (pushed.size && base) {
          const moves = [...pushed.entries()].flatMap(([id, d]) => {
            const b = base.get(id);
            return b ? [{ id, x: b.x + d.dx, y: b.y + d.dy }] : [];
          });
          pushedRef.current = new Map();
          // 좌표가 그 자리로 확정되므로 transform은 **즉시** 걷는다 —
          // 전이를 켠 채 지우면 원래 자리로 갔다가 다시 오는 것처럼 보인다.
          clearMarks(true);
          if (moves.length) a.commit(moves);
        } else {
          pushedRef.current = new Map();
          clearMarks(false);
        }
        endDrag();
        return;
      }

      if (!a.enabled || a.strength <= 0) return;

      // ── 끄는 중 ───────────────────────────────────────────────────
      // 자리는 **드래그 시작에 한 번만** 잰다(위 baseRef 주석).
      let rects = baseRef.current;
      if (!rects) {
        rects = a.rectsOf();
        baseRef.current = rects;
      }
      const movingRects: Rect[] = [];
      const statics: PushCandidate[] = [];
      for (const [id, r] of rects) {
        const off = moving.get(id);
        if (off) movingRects.push({ x: r.x + off.dx, y: r.y + off.dy, w: r.w, h: r.h });
        else statics.push({ id, rect: r });
      }
      if (!movingRects.length || !statics.length) return;

      const next = pushAway(movingRects, statics, {
        gap: a.gap,
        strength: a.strength,
      });

      // 이번에 안 밀리는 것은 **제자리로 돌아간다** — transform을 지우면
      // transition이 그 사이를 채운다(사용자 지시: "다시 원래 위치로
      // 자연스럽게 돌아와야 한다").
      for (const id of pushedRef.current.keys()) {
        if (next.has(id)) continue;
        const node = el(id);
        if (node) {
          node.style.transform = "";
          node.removeAttribute(MARK);
        }
      }
      for (const [id, d] of next) {
        const node = el(id);
        if (!node) continue;
        // transition은 **처음 한 번만** 건다. 매 프레임 다시 쓰면 그때마다
        // 스타일 재계산이 돌고, 값이 같아도 브라우저는 그걸 모른다.
        if (!easedRef.current.has(id)) {
          node.style.transition = `transform ${a.speedMs}ms cubic-bezier(.22,1,.36,1)`;
          node.setAttribute(MARK, "1");
          easedRef.current.add(id);
        }
        node.style.transform = `translate(${d.dx}px, ${d.dy}px)`;
      }
      pushedRef.current = next;
    };

    const off = subscribeDrag(apply);
    return () => {
      off();
      clearMarks(true);
    };
  }, []);
}
