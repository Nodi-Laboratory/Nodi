"use client";

/**
 * 아이템 레이어 — 배치 결과를 받아 아이템을 그린다.
 *
 * `CanvasWorkspace`에서 분리한 이유: 워크스페이스는 세션·스트림·저장을 다루고
 * 여기는 렌더만 한다. v1의 `ConceptCanvasWorkspace`가 397줄이었던 건 이 둘을
 * 한 파일에 뒀기 때문이다.
 */

import { ITEM_W } from "@/lib/canvas2/layout";
import type { CanvasItem } from "@/lib/canvas2/types";
import type { Placed } from "@/lib/canvas2/layout";
import { UNTAGGED } from "@/lib/canvas2/layout";
import type { Size } from "@/lib/canvas2/useItemLayout";
import { treeEdges } from "@/lib/canvas2/tree";
import { ConnectorLayer } from "./ConnectorLayer";
import { FigureItem } from "./FigureItem";
import type { ResizeCommit } from "./ResizeHandles";
import { TextItem } from "./TextItem";

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  sizes: Map<string, Size>;
  columnX: Map<string, number>;
  tagOrder: readonly string[];
  tagOptions: readonly string[];
  zoom: number;
  selectedIds: ReadonlySet<string>;
  editingId: string | null;
  /** 지금 이어 묻고 있는 트리 노드 (D151). */
  pickedId: string | null;
  measure: (id: string, el: HTMLElement | null) => void;
  handlers: {
    onSelect: (id: string | null, additive?: boolean) => void;
    onStartEdit: (id: string) => void;
    onCommitEdit: (id: string, body: string) => void;
    onCancelEdit: () => void;
    onDelete: (id: string) => void;
    onTagChange: (id: string, tag: string | null) => void;
    onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void;
    onReflow: (id: string) => void;
    onDismissReflow: (id: string) => void;
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
  columnX,
  tagOrder,
  tagOptions,
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
      <ColumnLabels items={items} positions={positions} columnX={columnX} tagOrder={tagOrder} />
      <ConnectorLayer items={items} positions={positions} sizes={sizes} />
      {items.map((item) => {
        const p = positions.get(item.id);
        if (!p) return null;
        if (item.kind === "figure") {
          return (
            <FigureItem
              key={item.id}
              item={item}
              x={p.x}
              y={p.y}
              measure={measure}
            />
          );
        }
        return (
          <TextItem
            key={item.id}
            item={item}
            x={p.x}
            y={p.y}
            zoom={zoom}
            selected={selectedIds.has(item.id)}
            editing={editingId === item.id}
            picked={pickedId === item.id}
            treeParentId={treeParentOf.get(item.id) ?? null}
            question={questionOf.get(item.id) ?? null}
            tagOptions={tagOptions}
            measure={measure}
            {...handlers}
          />
        );
      })}
    </>
  );
}

/**
 * 열 머리의 분류 라벨.
 *
 * 열 안에서 **가장 위에 있는 아이템** 위에 붙인다. 열의 y=0에 고정하면
 * pinned 아이템 때문에 열이 아래에서 시작할 때 라벨만 허공에 뜬다.
 */
function ColumnLabels({
  items,
  positions,
  columnX,
  tagOrder,
}: {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  columnX: Map<string, number>;
  tagOrder: readonly string[];
}) {
  const topByTag = new Map<string, number>();
  for (const it of items) {
    const p = positions.get(it.id);
    if (!p) continue;
    const tag = it.tag || UNTAGGED;
    // 열 x와 실제 x가 다르면 pinned이거나 자식이다 — 열 라벨의 기준이 아니다.
    if (columnX.get(tag) !== p.x) continue;
    const cur = topByTag.get(tag);
    if (cur === undefined || p.y < cur) topByTag.set(tag, p.y);
  }

  return (
    <>
      {tagOrder.map((tag) => {
        if (tag === UNTAGGED) return null;
        const y = topByTag.get(tag);
        const x = columnX.get(tag);
        if (y === undefined || x === undefined) return null;
        return (
          <div
            key={tag}
            className="label pointer-events-none absolute flex select-none items-center gap-2"
            style={{
              left: x - 16,
              top: y - 34,
              maxWidth: ITEM_W,
              color: "var(--c-ink-faint)",
              // 한글에 letter-spacing을 주면 자모가 벌어져 보인다. 라벨은
              // .label의 고정폭만 쓰고 자간은 되돌린다.
              letterSpacing: 0,
            }}
          >
            <span className="truncate">{tag}</span>
            {/* 열의 폭만큼 가로선을 그어 어디까지가 이 열인지 보이게 한다 */}
            <span
              aria-hidden
              className="h-px flex-1"
              style={{ background: "var(--c-rule)" }}
            />
          </div>
        );
      })}
    </>
  );
}
