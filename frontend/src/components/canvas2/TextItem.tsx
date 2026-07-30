"use client";

/**
 * 캔버스 글 아이템 — v1의 `ConceptCard`를 대체한다.
 *
 * ## 카드가 아니다
 *
 * 평소에는 **글자만** 있다. 테두리도 배경도 그림자도 없다. 마우스를 올리면
 * 반투명 박스가 뒤에 깔리고, 클릭하면 우상단에 `⋯`가 뜬다(사용자 지시).
 *
 * 유일한 상시 크롬은 **좌측 세로 괘선** 하나다. 색이 곧 정보다:
 *
 *     파랑  AI가 쓴 글
 *     주황  학생이 쓴 글
 *
 * 여백 주석(marginalia)의 형태를 빌린 것이고, 캔버스를 멀리서 봐도 학생이
 * 스스로 채운 분량이 한눈에 보인다.
 *
 * ## hover 박스가 레이아웃을 흔들면 안 된다
 *
 * 박스를 실제 요소로 넣으면 ResizeObserver 높이가 hover마다 달라져 배치가
 * 진동한다. `::before`처럼 흐름 밖에 두거나(여기서는 absolute 자식) 패딩을
 * 항상 잡아 둔다 — 여기서는 후자다. 패딩은 늘 있고 배경만 나타난다.
 *
 * ## 드래그 중에는 React를 건드리지 않는다
 *
 * 매 프레임 setState하면 아이템 전체가 리렌더된다(v1이 정확히 그래서 느렸다).
 * DOM transform만 직접 갱신하고 `pointerup`에서 한 번 커밋한다.
 */

import { memo, useCallback, useRef, useState } from "react";
import { ITEM_W } from "@/lib/canvas2/layout";
import type { CanvasItem } from "@/lib/canvas2/types";
import { AskFromNoteButton } from "./AskFromNoteButton";
import { ItemBody } from "./ItemBody";
import { ItemMenu } from "./ItemMenu";
import { ReflowButton } from "./ReflowButton";

/** 드래그로 인정하는 최소 이동(화면 px). 이보다 작으면 클릭이다. */
const DRAG_THRESHOLD = 4;

export interface TextItemProps {
  item: CanvasItem;
  x: number;
  y: number;
  selected: boolean;
  editing: boolean;
  tagOptions: readonly string[];
  /** 현재 줌. 화면 이동량을 world로 바꾸는 데 필요하다. */
  zoom: number;
  measureRef: (el: HTMLElement | null) => void;
  onSelect: (id: string | null) => void;
  onStartEdit: (id: string) => void;
  onCommitEdit: (id: string, body: string) => void;
  onCancelEdit: () => void;
  onDelete: (id: string) => void;
  onTagChange: (id: string, tag: string | null) => void;
  onDragEnd: (id: string, x: number, y: number) => void;
  onReflow: (id: string) => void;
  onDismissReflow: (id: string) => void;
  onAsk: (id: string) => void;
  onDismissAsk: (id: string) => void;
}

function TextItemImpl(props: TextItemProps) {
  const {
    item,
    x,
    y,
    selected,
    editing,
    tagOptions,
    zoom,
    measureRef,
    onSelect,
    onStartEdit,
    onCommitEdit,
    onCancelEdit,
    onDelete,
    onTagChange,
    onDragEnd,
    onReflow,
    onDismissReflow,
    onAsk,
    onDismissAsk,
  } = props;

  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; moved: boolean } | null>(null);

  const isAi = item.source === "ai";
  const accent = isAi ? "var(--c-live)" : "var(--c-hand)";
  const wash = isAi ? "var(--c-live-wash)" : "var(--c-hand-wash)";
  const active = hover || selected || editing;

  const setNode = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      measureRef(el);
    },
    [measureRef],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest("[data-no-pan]")) return; // 버튼·메뉴는 자기 일을 한다

      e.stopPropagation(); // Excalidraw가 선택 상자를 그리지 않게
      dragRef.current = { sx: e.clientX, sy: e.clientY, moved: false };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // 활성 포인터가 아니면 던진다(합성 이벤트·펜 태블릿 일부). 캡처는
        // 편의일 뿐이라 없어도 드래그는 동작한다 — 콘솔만 더럽히지 않는다.
      }
    },
    [editing],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      const el = rootRef.current;
      if (!d || !el) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        setDragging(true);
      }
      // React를 거치지 않는다 — 60fps로 리렌더하면 긴 문단에서 즉시 버벅인다.
      el.style.transform = `translate(${dx / zoom}px, ${dy / zoom}px)`;
    },
    [zoom],
  );

  const finishDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      const el = rootRef.current;
      dragRef.current = null;
      if (!d || !el) return;
      el.style.transform = "";
      setDragging(false);

      if (!d.moved) {
        onSelect(item.id); // 움직이지 않았으면 클릭이다
        return;
      }
      const dx = (e.clientX - d.sx) / zoom;
      const dy = (e.clientY - d.sy) / zoom;
      onDragEnd(item.id, x + dx, y + dy);
    },
    [item.id, onDragEnd, onSelect, x, y, zoom],
  );

  const showReflow = item._needsReflow && !item.data.reflowDismissed && !editing;
  const showAsk =
    item.source === "user" && !item.data.askHidden && !editing && (active || selected);

  return (
    <div
      ref={setNode}
      data-canvas-item={item.id}
      className="absolute"
      style={{
        left: x,
        top: y,
        width: ITEM_W,
        pointerEvents: "var(--c2-item-events)" as React.CSSProperties["pointerEvents"],
        zIndex: selected || editing ? 12 : dragging ? 11 : 10,
        cursor: editing ? "auto" : dragging ? "grabbing" : "grab",
        // 배치가 옮길 때는 부드럽게, 드래그 중에는 즉시.
        transition: dragging ? "none" : "left .28s cubic-bezier(.22,.9,.24,1), top .28s cubic-bezier(.22,.9,.24,1)",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEdit(item.id);
      }}
    >
      {/* hover/선택 박스 — 흐름 밖에 둬서 높이에 영향을 주지 않는다 */}
      <div
        aria-hidden
        className="pointer-events-none absolute transition-opacity duration-150"
        style={{
          inset: "-12px -16px",
          borderRadius: "var(--c-radius)",
          background: active ? wash : "transparent",
          border: `1px solid ${selected || editing ? accent : active ? "var(--c-rule)" : "transparent"}`,
          opacity: active ? 1 : 0,
          boxShadow: dragging ? "var(--c-shadow-lg)" : "none",
        }}
      />

      {/* 좌측 괘선 — 유일한 상시 크롬. 색이 곧 출처다 */}
      <div
        aria-hidden
        className="absolute"
        style={{
          left: -16,
          top: 2,
          bottom: 2,
          // 학생의 자국을 조금 더 굵게. 색만으로는 축소했을 때 구분이 약하다 —
          // 굵기라는 두 번째 신호를 보태면 색약이 있어도 구별된다.
          width: isAi ? 2 : 3,
          borderRadius: 2,
          background: accent,
          opacity: item._pending ? 0.4 : 0.85,
          transformOrigin: "top",
          animation: item._pending ? undefined : "c2-rule-draw .28s ease-out",
        }}
      />

      <div className="relative">
        {item.title && (
          <h3
            className="ui mb-2 text-[17px] font-semibold leading-snug"
            style={{ color: "var(--c-ink)" }}
          >
            {item.title}
          </h3>
        )}

        <div className="text-[15px]" style={{ color: "var(--c-ink)" }}>
          <ItemBody
            body={item.body}
            editing={editing}
            streaming={item._pending}
            onCommit={(next) => onCommitEdit(item.id, next)}
            onCancel={onCancelEdit}
          />
        </div>

        {(showReflow || showAsk) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {showReflow && (
              <ReflowButton
                onReflow={() => onReflow(item.id)}
                onDismiss={() => onDismissReflow(item.id)}
              />
            )}
            {showAsk && (
              <AskFromNoteButton
                onAsk={() => onAsk(item.id)}
                onDismiss={() => onDismissAsk(item.id)}
              />
            )}
          </div>
        )}

        {(selected || editing) && (
          <ItemMenu
            tag={item.tag}
            tagOptions={tagOptions}
            onEdit={() => onStartEdit(item.id)}
            onDelete={() => onDelete(item.id)}
            onTagChange={(t) => onTagChange(item.id, t)}
          />
        )}
      </div>
    </div>
  );
}

export const TextItem = memo(TextItemImpl);
