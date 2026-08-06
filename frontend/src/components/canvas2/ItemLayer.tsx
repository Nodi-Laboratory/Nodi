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
import type { EditContext, EditResult } from "@/lib/canvas2/useItemDrag";
import { ClipItem } from "./ClipItem";
import { ConnectorLayer } from "./ConnectorLayer";
import { FigureItem } from "./FigureItem";
import type { ResizeCommit } from "./ResizeHandles";
import { TextItem } from "./TextItem";

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  sizes: Map<string, Size>;
  tagOrder: readonly string[];
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
    onSelect: (id: string | null, additive?: boolean) => void;
    onStartEdit: (id: string) => void;
    onCommitEdit: (id: string, body: string) => void;
    onCancelEdit: () => void;
    onDelete: (id: string) => void;
    onTagChange: (id: string, tag: string | null) => void;
    onRenameTag: (from: string, to: string) => void;
    onRemoveTag: (tag: string) => void;
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
  tagOrder,
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
      <ColumnLabels items={items} positions={positions} tagOrder={tagOrder} />
      <ConnectorLayer items={items} positions={positions} sizes={sizes} />
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

/**
 * 열 머리의 분류 라벨.
 *
 * 그 태그에서 **가장 위에 있는 글** 위에 붙인다. 열의 y=0에 고정하면
 * pinned 아이템 때문에 열이 아래에서 시작할 때 라벨만 허공에 뜬다.
 *
 * ## x를 열 시작과 비교하면 안 된다 (D161)
 *
 * 예전에는 `columnX.get(tag) === p.x`인 글만 기준으로 삼았다. 세로로 쌓던
 * 시절에는 그게 "열의 본류"를 고르는 방법이었다. **tidy tree(D159)에서는
 * 뿌리가 자식들 위 가운데에 놓이므로 그 조건에 맞는 글이 하나도 없다** —
 * 라벨이 통째로 사라졌다. 지금은 가장 위에 있는 글을 그냥 고르고, 라벨도
 * 그 글의 왼쪽 위에 붙인다.
 */
function ColumnLabels({
  items,
  positions,
  tagOrder,
}: {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  tagOrder: readonly string[];
}) {
  /** 태그별로 가장 위에 있는 글의 자리. 라벨은 그 위에 붙는다. */
  const topByTag = new Map<string, Placed>();
  for (const it of items) {
    const p = positions.get(it.id);
    if (!p) continue;
    const tag = it.tag || UNTAGGED;
    const cur = topByTag.get(tag);
    if (cur === undefined || p.y < cur.y) topByTag.set(tag, p);
  }

  return (
    <>
      {tagOrder.map((tag) => {
        if (tag === UNTAGGED) return null;
        const at = topByTag.get(tag);
        if (!at) return null;
        /**
         * 라벨은 **자기 태그의 맨 위 글**을 따라간다. 열 시작(`columnX`)은
         * 안 본다.
         *
         * 예전에는 `Math.max(columnX, at.x)`였는데, 그 max가 실제로 값을
         * 바꾸는 경우는 `at.x < columnX` 하나뿐이다 — 학생이 카드를 자기 열
         * **왼쪽으로 끌어다 놓았을 때**(pinned, D122). 그때 라벨만 열 자리에
         * 남아 **엉뚱한 카드 위에 뜬다**(사용자 보고 2026-08-05: "생명공학
         * 카드 위에 천문학이라는 글자가 있다"). 뿌리가 자식들 위 가운데에
         * 놓이는 tidy tree(D159)에서는 `at.x >= columnX`라 max가 어차피
         * `at.x`를 골랐다 — 없애도 그쪽은 그대로다.
         */
        const x = at.x;
        const y = at.y;
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
