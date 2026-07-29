"use client";

/**
 * 아이템 목록의 소유자 — 낙관적 갱신 · 서버 동기화 · 되돌리기.
 *
 * ## 낙관적으로 먼저 그린다
 *
 * 학생이 글을 끌어 놓고 서버 응답을 기다리는 UI는 쓸 수 없다. 화면을 먼저
 * 바꾸고 서버에 보낸 뒤, 실패하면 되돌리고 **반드시 알린다.** 조용히 되돌리면
 * 학생은 자기가 뭘 잘못 눌렀다고 생각한다.
 *
 * ## 저장 실패가 학습을 막지 않는다
 *
 * "RAG는 채팅을 절대 막지 않는다"와 같은 정신이다. 저장이 실패해도 아이템은
 * 화면에 남고 편집도 계속 된다. 다만 실패 사실은 배너로 보인다.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { ItemPatch } from "@/lib/api/canvas";
import { deleteItem as apiDelete, patchItem as apiPatch } from "@/lib/api/canvas";
import type { CanvasItem, ItemData } from "./types";

export interface UndoEntry {
  label: string;
  run: () => void;
}

export interface CanvasItemsApi {
  items: CanvasItem[];
  /** 서버 스냅샷으로 통째 교체(재수화). */
  replaceAll: (items: CanvasItem[]) => void;
  /** 스트림 등에서 새 아이템을 밀어 넣는다(로컬 전용 — 저장은 호출부가). */
  upsertLocal: (items: CanvasItem[]) => void;
  /** 로컬만 바꾼다(스트리밍 중 본문 누적 등). */
  patchLocal: (id: string, patch: Partial<CanvasItem>) => void;
  /** 로컬 + 서버. 실패 시 롤백 + 오류 노출. */
  patch: (id: string, patch: ItemPatch, local?: Partial<CanvasItem>) => void;
  remove: (id: string) => void;
  /** 마지막 삭제 되돌리기. 없으면 null. */
  undo: UndoEntry | null;
  clearUndo: () => void;
  error: string | null;
  clearError: () => void;
  /** 세션에 존재하는 분류 목록(첫 등장 순서). */
  tagOptions: string[];
}

export function useCanvasItems(): CanvasItemsApi {
  const [items, setItems] = useState<CanvasItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const undoTimer = useRef<number | null>(null);

  const replaceAll = useCallback((next: CanvasItem[]) => setItems(next), []);

  const upsertLocal = useCallback((incoming: CanvasItem[]) => {
    setItems((prev) => {
      const byId = new Map(prev.map((i) => [i.id, i]));
      for (const it of incoming) byId.set(it.id, { ...byId.get(it.id), ...it });
      return [...byId.values()];
    });
  }, []);

  const patchLocal = useCallback((id: string, patch: Partial<CanvasItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  // ⚠️ `before`를 setState **업데이터 안에서** 읽으면 안 된다.
  //
  // 업데이터는 React가 렌더 단계에서 실행하므로 `setItems(...)`가 돌아온
  // 직후에는 아직 안 돌았을 수 있다. 그 상태에서 `before`를 보면 undefined라
  // 서버 호출이 통째로 건너뛰어진다 — 화면에는 반영됐는데 저장은 안 된,
  // 새로고침해야 알 수 있는 고장이다(실측으로 잡았다: 본문을 고쳤는데 서버
  // body가 그대로였다).
  //
  // 그래서 현재 `items`를 클로저로 직접 읽는다. 호출부(handlers)가 items가
  // 바뀔 때마다 다시 만들어지므로 항상 최신이다.
  const patch = useCallback(
    (id: string, serverPatch: ItemPatch, localExtra?: Partial<CanvasItem>) => {
      const before = items.find((i) => i.id === id);
      setItems((prev) =>
        prev.map((i) =>
          i.id === id ? { ...i, ...toLocal(serverPatch), ...localExtra } : i,
        ),
      );

      // 아직 서버에 없는 아이템(스트리밍 중·구 세션 파싱본)은 로컬로 끝낸다.
      if (!before || before._pending || before._legacy) return;

      void apiPatch(id, serverPatch).catch((e: Error) => {
        setError(`저장하지 못했습니다 — ${e.message}`);
        setItems((prev) => prev.map((i) => (i.id === id ? before : i)));
      });
    },
    [items],
  );

  const remove = useCallback(
    (id: string) => {
      const index = items.findIndex((i) => i.id === id);
      const removed = items[index];
      if (!removed) return;
      setItems((prev) => prev.filter((i) => i.id !== id));

      const wasPersisted = !removed._pending && !removed._legacy;
      if (wasPersisted) {
        void apiDelete(id).catch((e: Error) => {
          setError(`삭제하지 못했습니다 — ${e.message}`);
          setItems((prev) => insertAt(prev, removed, index));
        });
      }

      // 되돌리기: 서버에서 이미 지웠으므로 되살리려면 다시 만들어야 한다.
      // 여기서는 로컬 복구만 하고 저장은 다음 편집·스트림 저장에 맡긴다 —
      // 삭제한 뒤 6초 안에 되돌리는 흔치 않은 경로에 새 저장 왕복을 넣지 않는다.
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
      setUndo({
        label: "글을 지웠습니다",
        run: () => {
          setItems((prev) => insertAt(prev, { ...removed, _legacy: true }, index));
          setUndo(null);
        },
      });
      undoTimer.current = window.setTimeout(() => setUndo(null), 6000);
    },
    [items],
  );

  const tagOptions = useMemo(() => {
    const seen: string[] = [];
    for (const it of [...items].sort((a, b) => a.seq - b.seq)) {
      if (it.tag && !seen.includes(it.tag)) seen.push(it.tag);
    }
    return seen;
  }, [items]);

  return {
    items,
    replaceAll,
    upsertLocal,
    patchLocal,
    patch,
    remove,
    undo,
    clearUndo: useCallback(() => setUndo(null), []),
    error,
    clearError: useCallback(() => setError(null), []),
    tagOptions,
  };
}

/** 서버 패치(snake_case 경계) → 로컬 필드. */
function toLocal(p: ItemPatch): Partial<CanvasItem> {
  const out: Partial<CanvasItem> = {};
  if (p.x !== undefined) out.x = p.x;
  if (p.y !== undefined) out.y = p.y;
  if (p.pinned !== undefined) out.pinned = p.pinned;
  if (p.title !== undefined) out.title = p.title;
  if (p.body !== undefined) out.body = p.body;
  if (p.tag !== undefined) out.tag = p.tag;
  if (p.seq !== undefined) out.seq = p.seq;
  if (p.data !== undefined) out.data = p.data as ItemData;
  if (p.parent_item_id !== undefined) out.parentItemId = p.parent_item_id;
  return out;
}

function insertAt(list: CanvasItem[], item: CanvasItem, index: number): CanvasItem[] {
  const next = [...list];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}
