"use client";

/**
 * 아이템 레이어 — 배치 결과를 받아 아이템을 그린다.
 *
 * `CanvasWorkspace`에서 분리한 이유: 워크스페이스는 세션·스트림·저장을 다루고
 * 여기는 렌더만 한다. v1의 `ConceptCanvasWorkspace`가 397줄이었던 건 이 둘을
 * 한 파일에 뒀기 때문이다.
 */

import { COL_GAP, ITEM_W } from "@/lib/canvas2/layout";
import type { CanvasItem } from "@/lib/canvas2/types";
import type { Placed } from "@/lib/canvas2/layout";
import { UNTAGGED } from "@/lib/canvas2/layout";
import { ConnectorLayer } from "./ConnectorLayer";
import { TextItem } from "./TextItem";

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  heights: Map<string, number>;
  columnX: Map<string, number>;
  tagOrder: readonly string[];
  tagOptions: readonly string[];
  zoom: number;
  selectedId: string | null;
  editingId: string | null;
  measureRef: (id: string) => (el: HTMLElement | null) => void;
  handlers: {
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
  };
}

export function ItemLayer({
  items,
  positions,
  heights,
  columnX,
  tagOrder,
  tagOptions,
  zoom,
  selectedId,
  editingId,
  measureRef,
  handlers,
}: Props) {
  return (
    <>
      <ColumnLabels items={items} positions={positions} columnX={columnX} tagOrder={tagOrder} />
      <ConnectorLayer items={items} positions={positions} heights={heights} />
      {items.map((item) => {
        const p = positions.get(item.id);
        if (!p) return null;
        return (
          <TextItem
            key={item.id}
            item={item}
            x={p.x}
            y={p.y}
            zoom={zoom}
            selected={selectedId === item.id}
            editing={editingId === item.id}
            tagOptions={tagOptions}
            measureRef={measureRef(item.id)}
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
            className="label pointer-events-none absolute select-none truncate"
            style={{
              left: x - 16,
              top: y - 30,
              maxWidth: ITEM_W + COL_GAP,
              color: "var(--c-ink-faint)",
              textTransform: "uppercase",
            }}
          >
            {tag}
          </div>
        );
      })}
    </>
  );
}
