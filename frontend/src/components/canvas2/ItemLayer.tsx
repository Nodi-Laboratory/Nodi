"use client";

/**
 * 아이템 레이어 — 배치 결과를 받아 아이템을 그린다.
 *
 * `CanvasWorkspace`에서 분리한 이유: 워크스페이스는 세션·스트림·저장을 다루고
 * 여기는 렌더만 한다. v1의 `ConceptCanvasWorkspace`가 397줄이었던 건 이 둘을
 * 한 파일에 뒀기 때문이다.
 */

import type { CanvasItem } from "@/lib/canvas2/types";
import type { Placed } from "@/lib/canvas2/layout";
import type { Size } from "@/lib/canvas2/useItemLayout";
import { treeEdges } from "@/lib/canvas2/tree";
import type { EditContext, EditResult } from "@/lib/canvas2/useItemDrag";
import { ClipItem } from "./ClipItem";
import { ConnectorLayer } from "./ConnectorLayer";
import type { PortDragStart } from "./PortHandles";
import { FigureItem } from "./FigureItem";
import type { ResizeCommit } from "./ResizeHandles";
import { TextItem } from "./TextItem";

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  sizes: Map<string, Size>;
  tagOptions: readonly string[];
  /** 카드 수정 도구가 켜졌나 (D180). */
  cardEdit?: boolean;
  /** 별 포인터로 누를 때 맥락을 만든다. */
  beginEdit?: (id: string) => EditContext | null;
  /** 별 포인터를 놓았을 때 — 끊김·붙음을 저장한다. */
  onEditEnd?: (r: EditResult) => void;
  zoom: number;
  selectedIds: ReadonlySet<string>;
  editingId: string | null;
  /** 지금 이어 묻고 있는 트리 노드 (D151). */
  pickedId: string | null;
  measure: (id: string, el: HTMLElement | null) => void;
  handlers: {
    /** 연결선의 X를 눌렀다 — 그 카드의 부모를 끊는다 (D210 4-4). */
    onCut: (childId: string) => void;
    /**
     * 세로 이동 허용 범위 — **자식은 부모보다 위로 못 간다**
     * (사용자 지시 2026-08-09, `lib/canvas2/parentGuard.ts`).
     */
    dyLimitsFor: (movingIds: readonly string[]) => { min: number; max: number };
    /** 포트에서 끌기 시작 (D210 4-3). */
    onPortDrag: (start: PortDragStart, e: React.PointerEvent) => void;
    onSelect: (id: string | null, additive?: boolean) => void;
    onStartEdit: (id: string) => void;
    onCommitEdit: (id: string, body: string) => void;
    onCancelEdit: () => void;
    onDelete: (id: string) => void;
    onTagChange: (id: string, tag: string | null) => void;
    onRenameTag: (from: string, to: string) => void;
    onRemoveTag: (tag: string) => void;
    onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void;
    onAsk: (id: string) => void;
    onPick: (id: string) => void;
    onResize: (id: string, next: ResizeCommit) => void;
    onResetSize: (id: string) => void;
  };
}

export function ItemLayer({
  items,
  positions,
  sizes,
  tagOptions,
  cardEdit = false,
  beginEdit,
  onEditEnd,
  zoom,
  selectedIds,
  editingId,
  pickedId,
  measure,
  handlers,
}: Props) {
  /**
   * 답 → 그 답을 부른 질문 원문.
   *
   * 하단 입력창이든 "다시 질문하기"든 학생이 친 질문은 `data.askedQuestion`에
   * 실려 온다 — 질문을 아이템으로 만들지 않는 대신이다(D149).
   *
   * 부모 본문 폴백은 옛 행을 위한 것이다: "AI에게 묻기"로 만든 답은 부모가
   * 곧 질문이라 `askedQuestion`이 비어 있다.
   */
  const questionOf = new Map<string, string>();
  for (const it of items) {
    const carried = it.data.askedQuestion?.trim();
    if (carried) {
      questionOf.set(it.id, carried);
      continue;
    }
    if (!it.parentItemId) continue;
    const parent = items.find((p) => p.id === it.parentItemId);
    // 학생이 쓴 글에 대한 답일 때만 — AI 글에 딸린 AI 글은 "질문"이 아니다.
    if (parent && parent.source === "user" && parent.body.trim()) {
      questionOf.set(it.id, parent.body.trim());
    }
  }

  /**
   * 자식 → 트리 부모. 드래그가 **가지째** 따라가려면 DOM에서 자식을 찾을 수
   * 있어야 한다(사용자 지시 2026-08-02). 선택 집합을 prop으로 내리면
   * `memo(TextItem)`이 매번 깨지므로 표식만 내려보낸다.
   */
  const treeParentOf = new Map(treeEdges(items).map((e) => [e.to, e.from]));

  return (
    <>
      {/**
       * 열 머리의 분류 라벨은 **걷어냈다** (사용자 지시 2026-08-08).
       *
       * 캔버스 위에 회색 글씨가 열마다 떠 있는데, 정작 읽는 것은 카드다.
       * 태그는 카드 메뉴와 지도에 그대로 있으므로 알 길이 사라지지 않는다.
       */}
      <ConnectorLayer
        items={items}
        positions={positions}
        sizes={sizes}
        onCut={handlers.onCut}
      />
      {items.map((item) => {
        const p = positions.get(item.id);
        if (!p) return null;
        if (item.kind === "clip") {
          return (
            <ClipItem
              key={item.id}
              item={item}
              x={p.x}
              y={p.y}
              zoom={zoom}
              selected={selectedIds.has(item.id)}
              measure={measure}
              onSelect={handlers.onSelect}
              onDragEnd={handlers.onDragEnd}
              onDelete={handlers.onDelete}
              dyLimitsFor={handlers.dyLimitsFor}
            />
          );
        }
        if (item.kind === "figure") {
          return (
            <FigureItem
              key={item.id}
              item={item}
              x={p.x}
              y={p.y}
              measure={measure}
              zoom={zoom}
              selected={selectedIds.has(item.id)}
              onSelect={handlers.onSelect}
              onResize={handlers.onResize}
              onResetSize={handlers.onResetSize}
            />
          );
        }
        return (
          <TextItem
            key={item.id}
            item={item}
            x={p.x}
            y={p.y}
            // 부모 유무는 아이템마다 다르다 — 위 포트를 띄울지 정한다 (D210 4-3).
            hasParent={!!item.parentItemId}
            zoom={zoom}
            selected={selectedIds.has(item.id)}
            editing={editingId === item.id}
            picked={pickedId === item.id}
            treeParentId={treeParentOf.get(item.id) ?? null}
            question={questionOf.get(item.id) ?? null}
            tagOptions={tagOptions}
            measure={measure}
            cardEdit={cardEdit}
            beginEdit={beginEdit}
            onEditEnd={onEditEnd}
            {...handlers}
          />
        );
      })}
    </>
  );
}

