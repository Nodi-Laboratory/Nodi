"use client";

/**
 * 교과서 도판 (D86~D95, 조작 D147) — v1의 `FigureNode`를 캔버스 v2로 이식.
 *
 * ## 글 상자와 동등하게 다룬다 (D147)
 *
 * ReAct로 뜬 도판을 학생이 **옮기고·크기 조절하고·지울 수 있다.** 드래그·선택은
 * 글 상자(TextItem)와 같은 훅(`useItemDrag`)을 쓰고, 옮긴 자리는 `pinned=true`
 * + `x/y`로 저장돼 새로고침 후에도 유지된다(글 상자와 같은 경로). 크기 조절은
 * **도판만** 가능하고 비율을 고정한다(ResizeHandles `aspect`).
 *
 * ## signed URL은 만료된다 (D87)
 *
 * 이미지 주소는 백엔드가 서명해 주고 6시간 뒤 만료된다. **저장하지 않는다** —
 * 재수화 때는 빈 문자열로 그렸다가 `getFigure`로 다시 받는다. 만료된 URL로
 * 로드가 실패하면 **1회만** 재발급한다(무한 재시도로 서버를 두드리지 않게).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { getFigure } from "@/lib/api/retrieve";
import { ITEM_W } from "@/lib/canvas2/layout";
import { useItemDrag } from "@/lib/canvas2/useItemDrag";
import type { CanvasItem } from "@/lib/canvas2/types";
import type { ResizeCommit } from "./ResizeHandles";

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
  /** 손잡이로 도판 크기를 바꿨다 (D147). Task 5에서 소비. */
  onResize: (id: string, next: ResizeCommit) => void;
  /** 도판을 자동 크기로 되돌린다. Task 5에서 소비. */
  onResetSize: (id: string) => void;
}

export function FigureItem({
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
  const fig = item.data.figure;
  // 재발급으로 얻은 url만 상태로 들고, 평소에는 prop을 그대로 쓴다.
  //
  // prop을 state로 복사하면 이펙트에서 setState를 부르게 되고(연쇄 렌더),
  // 두 곳에 같은 값이 생겨 어느 쪽이 진실인지 흐려진다.
  const [refreshed, setRefreshed] = useState<string | null>(null);
  const [retried, setRetried] = useState(false);
  const [open, setOpen] = useState(false);

  const url = refreshed ?? fig?.url ?? "";
  const closeRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const setNode = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      measure(item.id, el);
    },
    [measure, item.id],
  );

  // 드래그·선택은 글 상자와 공유하는 훅이 맡는다 (D147). 도판엔 편집 모드가
  // 없으므로 항상 드래그 가능하다.
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

  // 새 좌표가 도착한 프레임에 남은 transform을 걷어낸다(TextItem과 동형).
  useLayoutEffect(() => {
    settle();
  }, [x, y, settle]);

  // 라이트박스: Escape로 닫고, 열릴 때 닫기 버튼에 포커스를 준다.
  // role="dialog"인데 키보드로 나갈 방법이 없으면 갇힌다.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!fig) return null;

  const refresh = () => {
    if (retried || !fig.figureId) return;
    setRetried(true);
    void getFigure(fig.figureId)
      .then((f) => setRefreshed(f.url ?? ""))
      .catch(() => {
        /* 만료 재발급 실패 — 스켈레톤으로 남는다 */
      });
  };

  const size = item.data.size;

  return (
    <>
      <div
        ref={setNode}
        data-canvas-item={item.id}
        // 함께 끌 대상을 DOM에서 찾기 위한 표식(글 상자와 같은 규약).
        data-selected={selected ? "1" : undefined}
        className="absolute"
        style={{
          left: x,
          top: y,
          width: size?.w ?? ITEM_W,
          // 크기를 정했으면 그 높이로 고정, 아니면 이미지가 정한다.
          height: size?.h,
          pointerEvents: "var(--c2-item-events)" as React.CSSProperties["pointerEvents"],
          zIndex: selected ? 12 : dragging ? 11 : 10,
          cursor: dragging ? "grabbing" : "grab",
          userSelect: "none",
          // 배치가 옮길 때는 부드럽게, 드래그 중에는 즉시(글 상자와 같은 이징).
          transition: dragging
            ? "none"
            : "left .28s cubic-bezier(.22,.9,.24,1), top .28s cubic-bezier(.22,.9,.24,1)",
        }}
        onPointerDown={dragHandlers.onPointerDown}
        onPointerMove={dragHandlers.onPointerMove}
        onPointerUp={dragHandlers.onPointerUp}
        onPointerCancel={dragHandlers.onPointerCancel}
        tabIndex={0}
        role="group"
        aria-label={fig.caption || "교과서 도판"}
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
        {/* 선택 강조 — 흐름 밖에 둬서 크기에 영향을 주지 않는다. 색은 오커(AI). */}
        <div
          aria-hidden
          className="pointer-events-none absolute transition-opacity duration-150"
          style={{
            inset: "-6px",
            borderRadius: "var(--c-radius)",
            border: `${selected ? Math.max(1, 1.5 / zoom) : 1}px solid ${
              selected ? "var(--c-live)" : "transparent"
            }`,
            opacity: selected ? 1 : 0,
            boxShadow: dragging ? "var(--c-shadow-lg)" : "none",
          }}
        />

        {/* 좌측 괘선 — 색이 곧 출처다(오커=AI). */}
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

        {/* 도판 몸통. 더블클릭하면 크게 본다 — 단일 클릭은 선택이다(글 상자가
            더블클릭으로 편집을 여는 것과 동형). `data-no-pan`을 두지 않아
            몸통을 잡고 드래그로 옮길 수 있다. */}
        <div
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (url) setOpen(true);
          }}
          className="block h-full w-full overflow-hidden rounded-lg border text-left"
          style={{ borderColor: "var(--c-rule)", background: "var(--c-raised)" }}
          title="더블클릭하면 크게 볼 수 있어요"
        >
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={fig.caption || "교과서 도판"}
              onError={refresh}
              draggable={false}
              className="pointer-events-none block w-full object-contain"
              style={{ background: "var(--c-sunk)", maxHeight: size ? undefined : "16rem" }}
            />
          ) : (
            <div
              className="flex h-40 items-center justify-center text-sm"
              style={{ background: "var(--c-sunk)", color: "var(--c-ink-faint)" }}
            >
              도판 불러오는 중…
            </div>
          )}
          <div className="px-3 py-2">
            <p className="line-clamp-2 text-[13px]" style={{ color: "var(--c-ink)" }}>
              {fig.caption || "설명 없음"}
            </p>
            <p className="label mt-1" style={{ color: "var(--c-ink-faint)", letterSpacing: 0 }}>
              교과서 {fig.page}쪽
            </p>
          </div>
        </div>
      </div>

      {/* 라이트박스는 body로 포털한다 — 변환 평면(scale) 안에서는 position:fixed가
          뷰포트 기준으로 동작하지 않는다(v1에서 같은 이유로 포털했다). */}
      {open &&
        url &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-8"
            style={{ background: "var(--c-overlay)" }}
            onClick={() => setOpen(false)}
            role="dialog"
            aria-modal="true"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={fig.caption || "교과서 도판"}
              className="max-h-full max-w-full rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="닫기"
              className="absolute right-6 top-6 rounded-full p-2"
              style={{ background: "var(--c-on-dark)", color: "var(--c-paper)" }}
            >
              <X size={18} />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
