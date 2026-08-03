"use client";

/**
 * 강의 클립 추천 카드 (D149). FigureItem의 이동/선택/삭제 배선을 본떠 만들되
 * 이미지·리사이즈·signed URL 재발급이 없다 — page_url은 안정적인 EBS 공식
 * 링크라 영속한다(types.ts). 클릭 시 새 탭으로 열고, 타임라인 시각은 텍스트로만
 * 안내한다(딥링크 seek 안 함).
 *
 * 드래그·선택은 글 상자·도판과 같은 훅(`useItemDrag`)을 쓴다. 여기서는
 * resize 관련 배선만 뺐다.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { PlayCircle, X } from "lucide-react";
import { ITEM_W } from "@/lib/canvas2/layout";
import { useItemDrag } from "@/lib/canvas2/useItemDrag";
import type { CanvasItem } from "@/lib/canvas2/types";

interface Props {
  item: CanvasItem;
  x: number;
  y: number;
  zoom: number;
  selected: boolean;
  measure: (id: string, el: HTMLElement | null) => void;
  onSelect: (id: string | null, additive?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void;
  onDelete: (id: string) => void;
}

export function ClipItem({
  item,
  x,
  y,
  zoom,
  selected,
  measure,
  onSelect,
  onDragEnd,
  onDelete,
}: Props) {
  const clip = item.data.clip;
  const [hover, setHover] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const setNode = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      measure(item.id, el);
    },
    [measure, item.id],
  );

  // 드래그·선택은 글 상자·도판과 공유하는 훅이 맡는다 (D147 동형). 클립엔
  // 편집 모드가 없으므로 항상 드래그 가능하다.
  const { dragging, settle, handlers: dragHandlers } = useItemDrag({
    id: item.id,
    x,
    y,
    zoom,
    selected,
    enabled: true,
    rootRef,
    onSelect,
    onDragEnd,
  });

  // 새 좌표가 도착한 프레임에 남은 transform을 걷어낸다(TextItem·FigureItem과 동형).
  useLayoutEffect(() => {
    settle();
  }, [x, y, settle]);

  if (!clip) return null;

  return (
    <div
      ref={setNode}
      data-canvas-item={item.id}
      data-selected={selected ? "1" : undefined}
      className="absolute rounded-lg border p-3"
      style={{
        left: x,
        top: y,
        width: ITEM_W,
        pointerEvents: "var(--c2-item-events)" as React.CSSProperties["pointerEvents"],
        background: "var(--c-raised)",
        borderColor: selected ? "var(--c-live)" : "var(--c-rule)",
        boxShadow: dragging ? "var(--c-shadow-lg)" : "var(--c-shadow-sm)",
        zIndex: selected ? 12 : dragging ? 11 : 10,
        cursor: dragging ? "grabbing" : "grab",
        userSelect: "none",
        transition: dragging
          ? "none"
          : "left .28s cubic-bezier(.22,.9,.24,1), top .28s cubic-bezier(.22,.9,.24,1)",
      }}
      onPointerDown={dragHandlers.onPointerDown}
      onPointerMove={dragHandlers.onPointerMove}
      onPointerUp={dragHandlers.onPointerUp}
      onPointerCancel={dragHandlers.onPointerCancel}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      tabIndex={0}
      role="group"
      aria-label={clip.title || "강의 클립"}
      onFocus={(e) => {
        // 키보드로 왔을 때만 선택한다 — 마우스는 pointerdown이 이미 정했다.
        if (!e.currentTarget.matches(":focus-visible")) return;
        onSelect(item.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onDelete(item.id);
        } else if (e.key === "Escape") {
          onSelect(null);
          (e.currentTarget as HTMLElement).blur();
        }
      }}
    >
      {/* 좌측 괘선 — 색이 곧 출처다(라이브=추천). */}
      <div
        aria-hidden
        className="absolute"
        style={{
          left: -16,
          top: 2,
          bottom: 2,
          width: 2,
          borderRadius: 2,
          background: "var(--c-live)",
          opacity: 0.85,
        }}
      />

      {/* × 삭제 — hover/선택 시 우상단. 드래그로 안 새게 pointerdown을 막는다. */}
      {(hover || selected) && (
        <button
          type="button"
          data-no-pan
          aria-label="클립 삭제"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(item.id);
          }}
          className="absolute -right-2 -top-2 z-20 flex h-7 w-7 items-center justify-center rounded-md border transition-colors"
          style={{
            background: "var(--c-raised)",
            borderColor: "var(--c-rule)",
            color: "var(--c-ink-soft)",
            boxShadow: "var(--c-shadow-sm)",
          }}
        >
          <X size={15} />
        </button>
      )}

      <div className="label mb-1" style={{ color: "var(--c-ink-soft)", letterSpacing: 0 }}>
        강의 클립 · {clip.timelineLabel}
      </div>
      <div className="text-sm font-medium" style={{ color: "var(--c-ink)" }}>
        {clip.title}
      </div>
      {clip.videoTitle ? (
        <div
          className="label mt-0.5 truncate"
          style={{ color: "var(--c-ink-faint)", letterSpacing: 0 }}
        >
          {clip.videoTitle}
        </div>
      ) : null}
      <a
        href={clip.pageUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-no-pan
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className="mt-2 inline-flex items-center gap-1 text-sm"
        style={{ color: "var(--c-hand)" }}
      >
        <PlayCircle size={15} /> EBS에서 보기 ({clip.timelineLabel})
      </a>
    </div>
  );
}
