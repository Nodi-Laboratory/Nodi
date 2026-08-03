"use client";

/**
 * 배치 훅 — 순수 엔진(`layout.ts`)을 React에 붙인다.
 *
 * ## 단방향 고정
 *
 *     높이(ResizeObserver)  →  배치  →  위치
 *
 * 위치가 크기에 영향을 주면 무한 루프가 된다(높이 변경 → 재배치 → DOM 갱신 →
 * 높이 변경 …). 그래서 **최대 폭을 고정**한다. 아이템은 내용에 따라 좁아질 수
 * 있지만 그 폭은 어디에 놓이든 같다 — 위치가 크기에 영향을 주지 않으므로
 * 루프가 성립하지 않는다.
 *
 * ## v1이 느렸던 이유를 반복하지 않는다
 *
 * v1은 d3-force 틱마다 positions Map을 새로 만들고 `{...c, x, y}`로 카드
 * 객체를 새로 만들어 넘겼다 — `memo(ConceptCard)`가 완전히 무력화되고 카드
 * 전체가 60fps로 리렌더됐다. 여기서는 **입력 시그니처가 바뀔 때만** 돌고,
 * rAF로 코얼레스해 프레임당 1회를 넘지 않는다.
 *
 * ## 태그 순서를 세션에 묶는다
 *
 * v1은 태그 슬롯 레지스트리를 훅의 ref에 뒀는데, 세션을 바꿔도 컴포넌트가
 * 리마운트되지 않아 이전 세션의 슬롯 번호가 그대로 남았다. "같은 세션은
 * 항상 같은 배치"(D90)가 세션 전환 경로에서만 조용히 깨졌다. 여기서는
 * 순서를 결과 state 안에 세션 키와 **함께** 들고 있어서 키가 바뀌면 자연히
 * 초기화된다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ITEM_W, layoutItems, type LayoutInput, type LayoutResult, type Placed } from "./layout";
import type { Rect } from "./rect";

/** 아직 실측 전인 아이템의 임시 크기. 첫 프레임에만 쓰인다. */
const FALLBACK: Size = { w: ITEM_W, h: 180 };

/** 실측 크기. */
export interface Size {
  w: number;
  h: number;
}

const EMPTY: LayoutResult = {
  positions: new Map(),
  columnX: new Map(),
  tagOrder: [],
};

export interface LayoutSource {
  id: string;
  tag: string | null;
  seq: number;
  pinned: boolean;
  x: number;
  y: number;
  parentItemId: string | null;
  /** 트리 판정용 (D151) — AI 개념 카드만 트리에 들어간다. */
  kind: string;
  source: string;
}

export interface UseItemLayout {
  positions: Map<string, Placed>;
  columnX: Map<string, number>;
  tagOrder: string[];
  /** 실측 크기. 폭도 값이다 — 아이템이 내용만큼만 차지한다. */
  sizes: Map<string, Size>;
  /**
   * 아이템 루트를 등록한다. 호출부가 `useCallback([measure, id])`로 자기
   * ref 콜백을 만든다 — 그래야 그 콜백이 렌더마다 바뀌지 않는다.
   */
  measure: (id: string, el: HTMLElement | null) => void;
  /** 외부 사정으로 다시 배치해야 할 때(그림이 바뀐 직후 등). */
  invalidate: () => void;
}

/** 배치 상태 + 그 배치가 어느 세션의 것인지. 둘을 같이 들고 있어야 리셋이 자연스럽다. */
interface LayoutState {
  key: string | null;
  result: LayoutResult;
}

export function useItemLayout(
  sessionKey: string | null,
  items: readonly LayoutSource[],
  getObstacles: () => Rect[],
): UseItemLayout {
  const [sizes, setSizes] = useState<Map<string, Size>>(() => new Map());
  const [state, setState] = useState<LayoutState>(() => ({ key: sessionKey, result: EMPTY }));
  const [nonce, setNonce] = useState(0);

  const observers = useRef<Map<string, ResizeObserver>>(new Map());

  // 값 시그니처 — 배열 아이덴티티가 아니라 실제 값이 바뀔 때만 재배치한다.
  const sig = items
    .map(
      (i) =>
        `${i.id}:${i.tag ?? ""}:${i.seq}:${i.pinned ? 1 : 0}:` +
        `${i.pinned ? `${Math.round(i.x)},${Math.round(i.y)}` : ""}:${i.parentItemId ?? ""}:` +
        `${i.kind}/${i.source}`,
    )
    .join("|");
  // 반올림한다 — 서브픽셀 흔들림으로 계속 재배치되지 않게.
  const zSig = items
    .map((i) => {
      const s = sizes.get(i.id);
      return s ? `${Math.round(s.w)}x${Math.round(s.h)}` : "";
    })
    .join(",");

  useEffect(() => {
    // 이펙트 본문에서 동기적으로 setState하지 않는다 — rAF 안에서 부른다.
    // 같은 프레임의 여러 변화가 여기서 한 번으로 합쳐진다.
    const raf = requestAnimationFrame(() => {
      const inputs: LayoutInput[] = items.map((it) => {
        const s = sizes.get(it.id) ?? FALLBACK;
        return { ...it, width: s.w, height: s.h };
      });
      const obstacles = getObstacles();
      setState((prev) => {
        // 세션이 바뀌었으면 태그 순서를 이어받지 않는다.
        const prevOrder = prev.key === sessionKey ? prev.result.tagOrder : [];
        return { key: sessionKey, result: layoutItems(inputs, obstacles, prevOrder) };
      });
    });
    return () => cancelAnimationFrame(raf);
    // sig/zSig가 items·sizes의 **값 수준** 의존성이다. 배열·Map을 그대로
    // 넣으면 매 렌더 새 아이덴티티라 rAF가 매 프레임 예약된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, zSig, sessionKey, nonce, getObstacles]);

  const invalidate = useCallback(() => setNonce((n) => n + 1), []);

  /**
   * 아이템 크기를 실측한다. **id마다 함수를 만들지 않는다.**
   *
   * 예전 계약은 `measureRef(id)`가 ref 콜백을 돌려주는 것이었는데, 그러면
   * 렌더마다 새 함수가 나온다:
   *
   *   (a) `memo(TextItem)`이 매번 깨진다 — prop 하나가 늘 새 값이다.
   *   (b) React가 ref를 **떼었다 다시 붙인다**(옛 콜백에 null, 새 콜백에 el).
   *       ResizeObserver가 그때마다 끊겼다 다시 붙는다.
   *
   * 실측: 글 21개에서 하나를 클릭하면 128회 렌더됐다.
   *
   * 이 함수는 의존성이 없어 **영원히 같은 값**이고, 호출부는 자기 id만
   * 곁들여 자기 콜백을 memo한다.
   */
  const measure = useCallback((id: string, el: HTMLElement | null) => {
    const map = observers.current;
    map.get(id)?.disconnect();
    map.delete(id);
    if (!el) return;

    const apply = (w: number, h: number) => {
      setSizes((prev) => {
        const cur = prev.get(id);
        // 1px 미만 변화는 무시 — 폰트 로딩·서브픽셀로 계속 흔들린다.
        if (cur && Math.abs(cur.w - w) < 1 && Math.abs(cur.h - h) < 1) return prev;
        const next = new Map(prev);
        next.set(id, { w, h });
        return next;
      });
    };

    const ob = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize?.[0];
      apply(box?.inlineSize ?? el.offsetWidth, box?.blockSize ?? el.offsetHeight);
    });
    ob.observe(el);
    map.set(id, ob);
    // 첫 측정은 즉시 — 옵저버 콜백은 다음 프레임이라 한 프레임 깜빡인다.
    if (el.offsetHeight > 0) apply(el.offsetWidth, el.offsetHeight);
  }, []);

  useEffect(() => {
    const map = observers.current;
    return () => {
      for (const ob of map.values()) ob.disconnect();
      map.clear();
    };
  }, []);

  return useMemo(
    () => ({
      positions: state.result.positions,
      columnX: state.result.columnX,
      tagOrder: state.result.tagOrder,
      sizes,
      measure,
      invalidate,
    }),
    [state, sizes, measure, invalidate],
  );
}
