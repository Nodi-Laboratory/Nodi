"use client";

/**
 * 아이템 드래그·선택 공유 훅 (D147).
 *
 * TextItem에 있던 드래그·선택·settle 로직을 뽑았다 — 글(TextItem)과
 * 도판(FigureItem)이 **같은 코드로** 움직이게 하기 위해서다. 복제하면
 * 시간이 지나며 둘이 어긋난다(CLAUDE.md의 "넷째 파싱을 만들면 어긋난다"와
 * 같은 정신). 로직 자체는 TextItem에서 실측으로 다듬어진 것이라 형태를
 * 그대로 보존한다.
 *
 * - 드래그 중에는 **React를 거치지 않고** DOM transform으로 움직인다.
 * - 함께 선택된 아이템(`[data-selected="1"]`)을 같은 양만큼 민다.
 * - 연결선은 `dragBus`로 따라간다.
 * - 좌표가 도착한 프레임에 transform을 걷어낸다(settle).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { clearDragOffsets, setDragOffsets } from "./dragBus";
import { clampDy } from "./parentGuard";
import { clearLiveLink, setLiveLink } from "./linkBus";
import {
  detachStep,
  type Candidate,
  type MagnetState,
} from "./detachDrag";
import type { Rect } from "./rect";

/** 드래그로 인정하는 최소 이동(화면 px). 이보다 작으면 클릭이다. */
const DRAG_THRESHOLD = 4;
/** 위치 커밋이 끝내 안 올 때 transform을 걷어내는 안전망(ms). */
const DROP_FALLBACK_MS = 300;

/**
 * 선택 요소 목록에 self를 중복 없이 합친다 (순수).
 *
 * self가 이미 선택 집합에 들어 있으면 다시 넣지 않는다 — 두 번 끌리거나
 * 이동량이 두 번 걸리는 것을 막는다. 순수하게 뽑아 node 환경에서 테스트한다
 * (repo가 jsdom 테스트를 뒤로 미룬다, vitest.config 참조).
 */
export function withSelf(
  selected: readonly HTMLElement[],
  self: HTMLElement | null,
): HTMLElement[] {
  const out = [...selected];
  if (self && !out.includes(self)) out.push(self);
  return out;
}

/**
 * 함께 끌 요소들. **캐시하지 않고 그때그때 조회한다.**
 *
 * ref 안에 배열로 담아 두면 React Compiler가 막는다(immutability). 속성
 * 선택자 조회는 마이크로초 단위라 매 프레임 불러도 괜찮다.
 */
export function peerEls(group: boolean, self: HTMLElement | null): HTMLElement[] {
  const selected = group
    ? Array.from(
        document.querySelectorAll<HTMLElement>('[data-canvas-item][data-selected="1"]'),
      )
    : [];
  return withSelf(selected, self);
}

/**
 * 카드 수정 도구로 끌 때 필요한 것들 (D180).
 *
 * **누를 때 한 번만** 만든다. 매 렌더에 후보 목록을 계산하면 카드 수만큼
 * 곱해진 일이 아무도 안 끄는 동안에도 계속 돈다.
 */
export interface EditContext {
  /** 이 카드의 트리 부모. null이면 끊을 것이 없다 — 그냥 이동 도구가 된다. */
  parentId: string | null;
  /** 내 자리(world). */
  rect: Rect;
  /** 붙을 수 있는 카드들. */
  candidates: Candidate[];
  /** 후보에서 뺄 id — 자기 자신과 자기 자손(순환 방지). */
  blocked: ReadonlySet<string>;
  /** 함께 움직일 id들 — 자기 가지 전체. */
  moving: readonly string[];
}

/** 손을 뗐을 때의 결말. */
export interface EditResult {
  id: string;
  /** 최종 이동량(world). */
  dx: number;
  dy: number;
  /** 부모에게서 끊겼나. */
  detached: boolean;
  /** 새로 붙을 부모. 없으면 안 붙었다. */
  attachTo: string | null;
}

/**
 * 이 id들의 아이템 요소. 카드 수정 도구는 **자기 가지 전체**를 데리고 간다 —
 * 선택 집합이 아니다(D154가 기본 드래그에서 한 것과 같은 정신).
 */
export function branchEls(ids: readonly string[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const id of ids) {
    const el = document.querySelector<HTMLElement>(
      `[data-canvas-item="${CSS.escape(id)}"]`,
    );
    if (el) out.push(el);
  }
  return out;
}

export interface UseItemDragArgs {
  id: string;
  x: number;
  y: number;
  /** 현재 줌. 화면 이동량을 world로 바꾼다. */
  zoom: number;
  selected: boolean;
  /** 드래그를 받을 수 있나 (TextItem은 편집 중이면 false). */
  enabled: boolean;
  /** 아이템 루트. 끄는 동안 이 요소의 transform을 직접 고친다. */
  rootRef: React.RefObject<HTMLElement | null>;
  onSelect: (id: string | null, additive?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void;
  /** 카드 수정 도구가 켜졌나 (D180). */
  editing?: boolean;
  /** 누를 때 한 번 불러 맥락을 받는다. null이면 평범한 이동으로 떨어진다. */
  beginEdit?: (id: string) => EditContext | null;
  /** 손을 뗐을 때. 관계 변경은 여기서 저장한다. */
  onEditEnd?: (r: EditResult) => void;
  /**
   * **자식은 부모보다 위로 못 간다** (사용자 지시 2026-08-09).
   *
   * 지금 끌고 있는 id들을 주면 세로 이동량의 허용 범위를 돌려준다
   * (`lib/canvas2/parentGuard.ts`). 없으면 제한이 없다.
   *
   * 여기서 부르는 이유는 **끄는 동안 손이 벽에 닿는 느낌**이 나야 하기
   * 때문이다. 놓을 때만 바로잡으면 카드가 손을 떠난 뒤 툭 튄다.
   */
  dyLimitsFor?: (movingIds: readonly string[]) => { min: number; max: number };
}

export interface UseItemDragResult {
  dragging: boolean;
  /** 좌표 도착 프레임에 호출해 남은 transform을 걷어낸다. */
  settle: () => void;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
}

export function useItemDrag({
  id,
  x,
  y,
  zoom,
  selected,
  enabled,
  rootRef,
  onSelect,
  onDragEnd,
  editing = false,
  beginEdit,
  onEditEnd,
  dyLimitsFor,
}: UseItemDragArgs): UseItemDragResult {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    sx: number;
    sy: number;
    moved: boolean;
    /** 선택된 것들을 함께 끄는 드래그인가. */
    group: boolean;
    /** 누를 때 이미 선택돼 있었나. */
    wasSelected: boolean;
    additive: boolean;
    /** 카드 수정 도구로 끄는 중이면 그 맥락. 아니면 null. */
    edit: EditContext | null;
    /** 이미 끊겼나. 한 번 끊기면 다시 붙기 전까지 장력이 없다. */
    broken: boolean;
    /** 마지막으로 걸린 자석. 손 뗄 때 여기에 붙인다. */
    magnet: MagnetState | null;
  } | null>(null);

  /**
   * 드롭 뒤 남은 transform을 걷어낸다.
   *
   * "인라인 transform이 남아 있고 지금 끄는 중이 아니면 정리한다"로 판정하므로
   * **함께 끌린 다른 아이템도 각자 알아서 정리된다** — 누가 누구를 끌었는지
   * 기억할 필요가 없다.
   */
  const settle = useCallback(() => {
    const el = rootRef.current;
    if (!el || dragRef.current || !el.style.transform) return;
    // 전이를 켠 채 transform을 지우면 요소가 원래 자리로 갔다가 다시 오는
    // 것처럼 보인다 — "클릭을 놓으면 잠깐 깜박거리는 현상".
    const prev = el.style.transition;
    el.style.transition = "none";
    el.style.transform = "";
    void el.offsetHeight; // 강제 리플로우 — transition:none을 이 프레임에 확정
    el.style.transition = prev;
    setDragging(false);
  }, [rootRef]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      // 왼쪽 버튼만 드래그다. 중버튼(휠클릭)은 화면 팬이므로 놓아 준다.
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest("[data-no-pan]")) return; // 버튼·메뉴·손잡이는 자기 일을 한다
      e.stopPropagation(); // Excalidraw가 선택 상자를 그리지 않게

      /**
       * 선택은 **여기서 한 번만** 정한다.
       *
       *   Shift            → 토글(여기서 끝)
       *   선택 안 된 것     → 이것 하나만
       *   이미 선택된 것    → 여기선 그대로 둔다. 끌면 함께 움직이고,
       *                       움직이지 않았으면 손 뗄 때 이 하나로 좁힌다.
       */
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (additive) onSelect(id, true);
      else if (!selected) onSelect(id, false);

      /**
       * 카드 수정 도구면 맥락을 **여기서 한 번** 만든다 (D180).
       *
       * 부모가 없으면(`beginEdit`이 null을 주거나 `parentId`가 null) 끊을
       * 것이 없다 — 사용자 지시대로 그냥 이동 도구가 된다. 그래도 맥락은
       * 들고 있는다: 뿌리 노드도 **다른 카드에 붙일** 수는 있어야 한다.
       */
      const edit = editing ? (beginEdit?.(id) ?? null) : null;

      dragRef.current = {
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        group: selected,
        wasSelected: selected,
        additive,
        edit,
        // 부모가 없으면 처음부터 끊긴 상태다 — 곧바로 자석이 돈다.
        broken: !edit?.parentId,
        magnet: null,
      };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // 활성 포인터가 아니면 던진다(합성 이벤트·펜 태블릿 일부). 캡처는
        // 편의일 뿐이라 없어도 드래그는 동작한다 — 콘솔만 더럽히지 않는다.
      }
    },
    [beginEdit, editing, enabled, id, onSelect, selected],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        setDragging(true);
      }
      // React를 거치지 않는다 — 60fps로 리렌더하면 긴 문단에서 즉시 버벅인다.
      // 함께 선택된 것들도 같은 양만큼 민다.
      let wx = dx / zoom;
      let wy = dy / zoom;

      /**
       * 카드 수정 도구 (D180) — **장력과 자석이 여기서 좌표를 바꾼다.**
       *
       * 포인터가 간 만큼 그대로 옮기지 않는다: 매여 있으면 뒤처지고, 붙으려
       * 하면 부모 쪽으로 끌린다. 계산은 전부 `detachDrag`가 하고 여기서는
       * 결과를 DOM과 통로에 흘린다.
       */
      if (d.edit) {
        const step = detachStep({
          dx: wx,
          dy: wy,
          hasParent: !!d.edit.parentId,
          broken: d.broken,
          rect: d.edit.rect,
          candidates: d.edit.candidates,
          blocked: d.edit.blocked,
        });
        if (step.breaking) d.broken = true;
        d.magnet = step.magnet;
        wx = step.offset.x;
        wy = step.offset.y;
        setLiveLink({
          childId: id,
          // 매여 있으면 원래 부모로, 끊긴 뒤에는 붙으려는 후보로 선이 간다.
          parentId: d.broken ? step.magnet.id : d.edit.parentId,
          strain: step.strain,
          snapped: step.magnet.snapped,
          broke: step.breaking,
        });
      }

      const peers = d.edit
        ? branchEls(d.edit.moving)
        : peerEls(d.group, rootRef.current);

      /**
       * 부모·자식 세로 규칙 (사용자 지시 2026-08-09).
       *
       * **자석·장력 뒤에** 건다 — 자석이 끌어당긴 자리도 규칙을 지켜야 한다.
       * 가로는 안 건드린다: 규칙이 말하는 것은 세로 순서뿐이고, 가로까지
       * 잠그면 열을 옮기는 평범한 이동이 막힌다.
       */
      if (dyLimitsFor) {
        const ids = peers
          .map((el) => el.getAttribute("data-canvas-item") ?? "")
          .filter(Boolean);
        wy = clampDy(wy, dyLimitsFor(ids));
      }

      const shift = `translate(${wx}px, ${wy}px)`;
      for (const el of peers) {
        el.style.transition = "none";
        el.style.transform = shift;
      }
      // 연결선도 같이 움직여야 한다 — 상자만 가고 선이 남으면 관계가 끊겨
      // 보인다. 역시 React를 거치지 않는다.
      setDragOffsets(
        peers.map((el) => el.getAttribute("data-canvas-item") ?? "").filter(Boolean),
        wx,
        wy,
      );
    },
    [id, zoom, rootRef, dyLimitsFor],
  );

  const finishDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;

      const peers = d.edit
        ? branchEls(d.edit.moving)
        : peerEls(d.group, rootRef.current);
      // 연결선은 이제 React가 낸 최종 좌표를 쓴다.
      clearDragOffsets();
      clearLiveLink();
      if (!d.moved) {
        // 움직이지 않은 클릭. 선택은 pointerdown에서 이미 정해졌고, 남은 경우는
        // 하나뿐이다 — 여럿이 잡힌 상태에서 그중 하나를 그냥 눌렀을 때
        // **그 하나로 좁힌다.**
        if (!d.additive && d.wasSelected) onSelect(id, false);
        setDragging(false);
        for (const el of peers) el.style.transition = "";
        return;
      }
      const rawX = (e.clientX - d.sx) / zoom;
      const rawY = (e.clientY - d.sy) / zoom;
      // transform은 **지우지 않는다.** 새 left/top이 오기 전에 지우면 한 프레임
      // 원래 자리로 돌아갔다 오면서 깜박인다. settle()이 정리한다.
      for (const el of peers) el.style.transition = "";

      /**
       * 카드 수정 도구 (D180) — 관계 변경과 좌표를 **한 번에** 넘긴다.
       *
       * 좌표는 화면에 보이던 그 자리다(장력·자석이 반영된 값). 포인터 좌표를
       * 그대로 쓰면 손 뗀 순간 카드가 툭 튄다 — 붙는 연출이 특히 그렇다.
       */
      if (d.edit && onEditEnd) {
        const step = detachStep({
          dx: rawX,
          dy: rawY,
          hasParent: !!d.edit.parentId,
          broken: d.broken,
          rect: d.edit.rect,
          candidates: d.edit.candidates,
          blocked: d.edit.blocked,
        });
        const attach = step.magnet.snapped ? step.magnet.id : null;
        onEditEnd({
          id,
          dx: step.offset.x,
          dy: step.offset.y,
          detached: d.broken && !attach,
          attachTo: attach,
        });
        window.setTimeout(settle, DROP_FALLBACK_MS);
        return;
      }

      const dx = rawX;
      // 화면에서 막힌 만큼 저장도 막힌다 — 안 그러면 손을 뗀 순간 규칙을
      // 어긴 자리로 튄다(끄는 동안 보이던 자리와 저장되는 자리가 갈린다).
      const dy = dyLimitsFor
        ? clampDy(
            rawY,
            dyLimitsFor(
              peers.map((el) => el.getAttribute("data-canvas-item") ?? "").filter(Boolean),
            ),
          )
        : rawY;
      onDragEnd(id, x + dx, y + dy, dx, dy);
      // 좌표가 끝내 안 바뀌는 경우(같은 자리 재배치)의 안전망.
      window.setTimeout(settle, DROP_FALLBACK_MS);
    },
    [id, onDragEnd, onEditEnd, onSelect, settle, x, y, zoom, rootRef, dyLimitsFor],
  );

  // 언마운트 시 남은 드래그 상태를 정리한다.
  useEffect(
    () => () => {
      dragRef.current = null;
    },
    [],
  );

  return {
    dragging,
    settle,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishDrag,
      onPointerCancel: finishDrag,
    },
  };
}
