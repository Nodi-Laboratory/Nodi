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
import { Play, PlayCircle, X } from "lucide-react";
import { useItemDrag } from "@/lib/canvas2/useItemDrag";
import { useClipThumb } from "@/lib/canvas2/useClipThumb";
import type { CanvasItem } from "@/lib/canvas2/types";

/**
 * 클립 카드 한 변 (D163 → D190).
 *
 * ITEM_W(560) → 340 → **240 정사각형**. 개념 카드 **옆에** 붙는 곁다리라
 * (layout ATTACH_KINDS) 답보다 크면 어느 쪽이 답인지 안 갈린다.
 *
 * 정사각형인 이유는 **썸네일이 들어가서**다(사용자 지시 2026-08-06). 제목과
 * "EBS에서 이어 보기" 사이에 그림이 앉으면 세로가 늘어나는데, 폭에 맞춰
 * 정사각으로 고정하면 여러 장이 붙어도 줄이 흐트러지지 않는다. 글자도 함께
 * 줄였다 — 카드만 줄이면 글자가 상자를 꽉 채워 답답해진다.
 */
const CLIP_SIDE = 240;

interface Props {
  item: CanvasItem;
  x: number;
  y: number;
  zoom: number;
  selected: boolean;
  measure: (id: string, el: HTMLElement | null) => void;
  onSelect: (id: string | null, additive?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void;
  /** 세로 이동 허용 범위 (`lib/canvas2/parentGuard.ts`). */
  dyLimitsFor?: (movingIds: readonly string[]) => { min: number; max: number };
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
  dyLimitsFor,
  onDelete,
}: Props) {
  const clip = item.data.clip;
  const thumbUrl = useClipThumb(clip?.clipId);
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
    dyLimitsFor,
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
      // 주인 카드가 움직이면 함께 간다 (D211 6).
      data-follows={item.parentItemId ?? undefined}
      data-canvas-clip={clip.clipId}
      data-selected={selected ? "1" : undefined}
      className="absolute flex flex-col rounded-lg border p-2.5"
      style={{
        left: x,
        top: y,
        width: CLIP_SIDE,
        // 손가락으로 끌려면 필요하다 — 없으면 브라우저가 터치를 스크롤로 채간다(TextItem 머리말).
        touchAction: "none",
        height: CLIP_SIDE,
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

      {/* 머리 — 무엇인지(EBS 강의)와 어디인지(타임라인)를 한 줄로. */}
      <div className="flex shrink-0 items-center gap-1">
        <PlayCircle size={13} style={{ color: "var(--c-live-deep)", flexShrink: 0 }} />
        <span
          className="label"
          style={{ color: "var(--c-ink-soft)", letterSpacing: 0, fontSize: 10 }}
        >
          EBS 강의
        </span>
        <span
          className="label ml-auto rounded px-1 py-px"
          style={{
            color: "var(--c-live-deep)",
            background: "var(--c-live-wash, transparent)",
            border: "1px solid var(--c-rule)",
            letterSpacing: 0,
            fontSize: 10,
          }}
        >
          {clip.timelineLabel}
        </span>
      </div>

      {/**
       * 제목 — **두 줄까지.** 길다고 늘어나면 정사각형이 깨진다.
       *
       * 어느 강의인지(`videoTitle`)는 줄로 두지 않고 툴팁으로 옮겼다 (D190).
       * 240 정사각형에 썸네일까지 넣으면 그 줄이 들어갈 자리가 없는데,
       * 지워 버리면 "이게 무슨 강의였지"에 답할 방법이 아예 사라진다.
       */}
      <div
        className="mt-1 shrink-0 font-medium leading-snug line-clamp-2"
        style={{ color: "var(--c-ink)", fontSize: 12.5 }}
        title={clip.videoTitle || undefined}
      >
        {clip.title}
      </div>

      {/**
       * 썸네일 — 제목과 "이어 보기" 사이 (D190, 사용자 지시 2026-08-06).
       *
       * 남는 높이를 **전부** 쓴다(`flex-1`). 고정 높이로 두면 제목이 한 줄인
       * 카드와 두 줄인 카드의 아래 여백이 달라져 정사각형 안이 들쭉날쭉해진다.
       *
       * 실제 그 강의의 장면은 아니다 — EBS 썸네일을 가져올 방법이 없어(저작권·
       * 차단) 관리자가 올려 둔 그림 중 하나를 clip id로 골라 쓴다. 그래서
       * **알림 문구를 달지 않는다**: 카드가 무엇인지 말해 주는 장식이지 그
       * 영상의 한 장면이라고 주장하지 않는다.
       *
       * 그림이 없으면(관리자가 아직 안 올렸거나 받기 실패) 자리를 비운다 —
       * 깨진 이미지 아이콘보다 낫다. **재생 버튼은 그때도 남긴다**: 그림이
       * 없다고 이 카드가 영상이 아닌 것은 아니다.
       *
       * ## 눌리는 자리다
       *
       * 재생 버튼이 아무 일도 안 하면 거짓말이다 — 학생은 그걸 누른다. 그림
       * 영역 자체가 아래 글자 링크와 **같은 곳으로 가는 링크**다.
       *
       * 드래그로 새지 않게 `data-no-pan` + pointerdown 차단을 건다(아래 글자
       * 링크와 같은 처리). 안 걸면 카드를 끌려다가 EBS가 열린다.
       */}
      <a
        href={clip.pageUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-no-pan
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        aria-label={`${clip.title} — EBS에서 재생`}
        className="group relative my-1.5 min-h-0 flex-1 overflow-hidden rounded"
        style={{ background: "var(--c-sunk, rgba(0,0,0,.04))" }}
      >
        {thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- object URL이라 next/image가 못 다룬다
          <img
            src={thumbUrl}
            alt=""
            aria-hidden
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : null}

        {/**
         * 반투명 재생 버튼 (사용자 지시 2026-08-06).
         *
         * ## ⚠️ 여기서 재생되지 않는다 — 그게 설계다
         *
         * 영상을 우리가 받아서 틀면 저작권 문제가 된다(사용자 확인 2026-08-06).
         * 이 버튼이 하는 일은 **EBS로 보내는 것**이고, 그래서 아래 글자 링크와
         * 같은 곳으로 간다. 그림도 그 영상의 장면이 아니라 대역이다.
         *
         * **여기에 플레이어를 붙이지 마라.** "버튼이 있는데 왜 안 틀어지지"는
         * 자연스러운 다음 생각인데, 그 순간 이 기능은 우리가 감당 못 할 것이 된다.
         *
         * ## 왜 색 토큰을 안 쓰나
         *
         * 이 원 아래 오는 것은 우리 배경이 아니라 **남의 사진**이다. 밝은 그림
         * 에서도 어두운 그림에서도 보여야 하므로 흰 테두리 + 반투명 검정으로
         * 둘 다 잡는다 — 테마 색은 그 대비를 보장하지 못한다.
         */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span
            className="flex items-center justify-center rounded-full transition-transform group-hover:scale-110"
            style={{
              width: 34,
              height: 34,
              background: "rgba(0,0,0,.42)",
              border: "1.5px solid rgba(255,255,255,.85)",
              backdropFilter: "blur(2px)",
            }}
          >
            {/* 삼각형을 살짝 오른쪽으로 — 시각 무게중심이 왼쪽에 쏠린다. */}
            <Play size={15} fill="#fff" color="#fff" style={{ marginLeft: 2 }} />
          </span>
        </span>
      </a>

      <a
        href={clip.pageUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-no-pan
        data-clip-link
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 truncate"
        style={{ color: "var(--c-hand)", fontSize: 12 }}
      >
        EBS에서 이어 보기 →
      </a>
    </div>
  );
}
