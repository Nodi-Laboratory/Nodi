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
import {
  createItems as apiCreate,
  deleteItem as apiDelete,
  patchItem as apiPatch,
} from "@/lib/api/canvas";
import { isRealId } from "@/lib/ids";
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
  /** 임시 id 아이템을 서버가 준 진짜 행으로 교체한다(스트림 저장 완료). */
  replaceTemp: (tempIds: string[], saved: CanvasItem[]) => void;
  /** 학생이 캔버스에 직접 쓴 글. 만들고 바로 저장한다. 반환은 임시 id. */
  createNote: (sessionId: string, x: number, y: number, seq: number) => string;
  /** 로컬 + 서버. 실패 시 롤백 + 오류 노출. */
  patch: (id: string, patch: ItemPatch, local?: Partial<CanvasItem>) => void;
  /**
   * 여러 글을 한꺼번에 옮긴다 (D143 재배치).
   *
   * `patch`를 반복해서 부르면 안 된다 — 되돌리기가 **마지막 하나만** 남아,
   * 스무 개를 옮겨 놓고 되돌리면 하나만 제자리로 온다. 여기서는 전체를 한
   * 항목으로 되돌린다.
   */
  moveMany: (moves: readonly { id: string; x: number; y: number }[], label: string) => void;
  /**
   * 여러 글의 분류를 한꺼번에 바꾼다 — 트리 분리 (D151).
   *
   * `moveMany`와 같은 이유로 따로 있다: 하나씩 patch하면 되돌리기가 마지막
   * 하나만 남아, 가지째 옮겨 놓고 되돌리면 한 장만 제자리로 온다.
   */
  tagMany: (ids: readonly string[], tag: string | null, label: string) => void;
  /**
   * 글마다 **다른** 수정을 한꺼번에 (D156 트리 분리 선택지).
   *
   * `tagMany`가 "같은 값을 여럿에"라면 이쪽은 "제각각을 여럿에"다 — 가지를
   * 할아버지에게 이어 붙이면서 자기만 분류를 바꾸는 경우가 그렇다.
   * 되돌리기는 역시 한 항목이다.
   */
  patchMany: (
    entries: readonly { id: string; patch: ItemPatch }[],
    label: string,
    opts?: {
      /**
       * "재배치" 배지를 달 것인가 (기본 true).
       *
       * 분류를 바꾸면 자리가 어색해지므로 권할 만하다. 그런데 **학생이 직접
       * 끌어다 놓은 경우**에는 방금 정한 자리에 대고 "다시 배치할까요"를
       * 묻는 셈이라 어색하고, 가지 전체에 배지가 우수수 뜬다(D180).
       */
      reflow?: boolean;
    },
  ) => void;
  remove: (id: string) => void;
  /**
   * 마지막 조작 되돌리기(삭제·본문 수정·분류 변경·이동). 없으면 null.
   *
   * 그림(Excalidraw)의 되돌리기와 **섞지 않는다.** 한 곳에 합치면 Ctrl+Z가
   * 무엇을 되돌릴지 학생이 예측할 수 없다 — 그림은 Excalidraw의 Ctrl+Z가,
   * 글은 이 토스트가 맡는다.
   */
  undo: UndoEntry | null;
  clearUndo: () => void;
  error: string | null;
  clearError: () => void;
  /** 세션에 존재하는 분류 목록(첫 등장 순서). */
  tagOptions: string[];
}

/** 되돌리기 안내가 떠 있는 시간(ms). */
const UNDO_MS = 6000;

/**
 * 이 수정을 되돌릴 수 있게 보여 줄 것인가, 보여 준다면 뭐라고 할 것인가.
 *
 * **시스템이 붙이는 변경은 제외한다** — `data`(버튼 숨김 표시)나 `seq`를
 * 되돌려 봐야 학생 눈에는 아무 일도 안 일어난다. 그런 것까지 토스트를 띄우면
 * 정작 중요한 되돌리기가 묻힌다.
 */
function undoLabel(p: ItemPatch, before: CanvasItem): string | null {
  if (p.body !== undefined) return "글을 고쳤습니다";
  if (p.tag !== undefined) return "분류를 바꿨습니다";
  if (p.title !== undefined) return "제목을 고쳤습니다";
  /**
   * 크기 조절은 위치보다 먼저 본다 (D142).
   *
   * 왼쪽·위 손잡이로 줄이면 좌표도 함께 바뀌는데, 그걸 "위치를 옮겼습니다"로
   * 부르면 되돌리기가 자리만 되돌리고 크기는 그대로 둔다 — 학생이 보기에
   * 되돌리기가 반만 듣는다. `data` 전체를 되돌리므로 둘이 같이 돌아온다.
   */
  const size = (p.data as ItemData | undefined)?.size;
  const had = before.data.size;
  if (p.data !== undefined && (size?.w !== had?.w || size?.h !== had?.h)) {
    return size ? "크기를 바꿨습니다" : "크기를 되돌렸습니다";
  }
  // 위치는 드래그와 "위치 정리" 둘 다 여기로 온다.
  if (p.x !== undefined || p.y !== undefined) return "위치를 옮겼습니다";
  return null;
}

export function useCanvasItems(): CanvasItemsApi {
  const [items, setItems] = useState<CanvasItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const undoTimer = useRef<number | null>(null);
  /**
   * 승격(로컬 전용 → 서버 행) 요청이 나가 있는 아이템 (D147).
   *
   * 승격은 **행을 만드는** 일이라 두 번 하면 글이 복제된다. 그런데 응답이
   * 오기 전에 또 만질 수 있다 — 여러 글을 함께 끌면 `moveMany`가 하나씩
   * patch를 부르고, 학생이 곧바로 다시 끌 수도 있다. 그때 `_legacy`는 아직
   * true이므로 옛 코드는 조건 없이 또 만들었다.
   *
   * 두 번째 호출은 로컬만 고치고 지나간다. 첫 요청이 끝날 때 서버 값을
   * 넣으면서 **로컬의 최신 본문·좌표를 지키므로**(아래 .then) 잃는 것이 없다.
   */
  const promoting = useRef<Set<string>>(new Set());

  /**
   * 되돌리기 항목을 띄운다. 타이머를 한 곳에서 관리해, 연달아 조작해도
   * 마지막 것만 보이고 앞의 타이머가 새 항목을 지우지 않게 한다.
   */
  const showUndo = useCallback((entry: UndoEntry) => {
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    setUndo(entry);
    undoTimer.current = window.setTimeout(() => setUndo(null), UNDO_MS);
  }, []);

  const replaceAll = useCallback((next: CanvasItem[]) => setItems(next), []);

  const upsertLocal = useCallback((incoming: CanvasItem[]) => {
    setItems((prev) => {
      const byId = new Map(prev.map((i) => [i.id, i]));
      for (const it of incoming) byId.set(it.id, { ...byId.get(it.id), ...it });
      return [...byId.values()];
    });
  }, []);

  /**
   * 임시 id → 서버 id 교체.
   *
   * 순서를 지켜야 한다 — 화면에 있던 자리에 그대로 넣는다. 뒤에 붙이면
   * 스트리밍이 끝나는 순간 아이템들이 자리를 바꾼다.
   */
  const replaceTemp = useCallback((tempIds: string[], saved: CanvasItem[]) => {
    setItems((prev) => {
      const map = new Map(tempIds.map((t, i) => [t, saved[i]]));
      const out: CanvasItem[] = [];
      for (const it of prev) {
        const replacement = map.get(it.id);
        if (replacement) {
          // 서버 값을 정본으로 하되, 스트리밍 중 붙은 클라이언트 표시는 버린다.
          out.push(replacement);
          map.delete(it.id);
        } else {
          out.push(it);
        }
      }
      // 화면에 없던 저장분(경합으로 사라진 경우)은 뒤에 붙인다.
      for (const left of map.values()) if (left) out.push(left);
      return remapParents(out, tempIds, saved);
    });
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

      if (!before) return;
      // 스트리밍 중인 아이템은 done에서 일괄 저장된다 — 여기서 건드리지 않는다.
      if (before._pending) return;

      // 구 세션에서 파싱만 해 온 아이템(_legacy)은 서버에 아직 행이 없다.
      // **첫 편집이 곧 마이그레이션이다** — 이때 만든다. 전 세션을 한 번에
      // 옮기면 안 쓰는 세션까지 행이 생긴다.
      if (before._legacy) {
        // 이미 만드는 중이면 **다시 만들지 않는다** — 두 번 만들면 글이 복제된다.
        if (promoting.current.has(id)) return;
        promoting.current.add(id);
        const merged = { ...before, ...toLocal(serverPatch), ...localExtra };
        void apiCreate(before.sessionId, [
          {
            kind: merged.kind,
            source: merged.source,
            node_id: merged.nodeId,
            parent_item_id: null,
            title: merged.title,
            body: merged.body,
            tag: merged.tag,
            x: merged.x,
            y: merged.y,
            pinned: merged.pinned,
            seq: merged.seq,
            data: merged.data,
          },
        ])
          .then(([saved]) => {
            if (!saved) return;
            // 저장되는 사이 학생이 더 고쳤을 수 있다 — 로컬 본문·위치를 지키고
            // id와 서버 소유 필드만 갈아 끼운다.
            setItems((prev) => {
              const next = prev.map((i) =>
                i.id === id
                  ? { ...saved, body: i.body, x: i.x, y: i.y, pinned: i.pinned, tag: i.tag }
                  : i,
              );
              // **자식의 parentItemId도 함께 갈아야 한다.** 안 하면 이 메모를
              // 부모로 갖던 AI 응답이 사라진 id를 가리켜 연결선이 조용히
              // 끊긴다(화면에서 관계가 없어진 것처럼 보인다).
              return remapParents(next, [id], [saved]);
            });
          })
          .catch((e: Error) => setError(`저장하지 못했습니다 — ${e.message}`))
          .finally(() => promoting.current.delete(id));
        return;
      }

      // 학생이 한 조작이면 되돌릴 수 있게 한다.
      //
      // 예전에는 **삭제만** 되돌릴 수 있었다. 본문을 고치거나 잘못 끌어 놓은
      // 것도 되돌아가야 자연스러운데 그 경로가 없었다.
      const label = undoLabel(serverPatch, before);
      if (label) {
        const revert: ItemPatch = {};
        if (serverPatch.body !== undefined) revert.body = before.body;
        if (serverPatch.tag !== undefined) revert.tag = before.tag;
        if (serverPatch.title !== undefined) revert.title = before.title;
        if (serverPatch.x !== undefined) revert.x = before.x;
        if (serverPatch.y !== undefined) revert.y = before.y;
        if (serverPatch.pinned !== undefined) revert.pinned = before.pinned;
        if (serverPatch.data !== undefined) revert.data = before.data;
        showUndo({
          label,
          run: () => {
            // 되돌리기는 다시 쌓지 않는다 — 무한 순환이 된다.
            setItems((prev) => prev.map((i) => (i.id === id ? before : i)));
            setUndo(null);
            void apiPatch(id, revert).catch((e: Error) =>
              setError(`되돌리지 못했습니다 — ${e.message}`),
            );
          },
        });
      }

      void apiPatch(id, serverPatch).catch((e: Error) => {
        setError(`저장하지 못했습니다 — ${e.message}`);
        setItems((prev) => prev.map((i) => (i.id === id ? before : i)));
      });
    },
    [items, showUndo],
  );

  const moveMany = useCallback(
    (moves: readonly { id: string; x: number; y: number }[], label: string) => {
      const before = new Map<string, CanvasItem>();
      for (const m of moves) {
        const it = items.find((i) => i.id === m.id);
        if (it) before.set(m.id, it);
      }
      const targets = moves.filter((m) => before.has(m.id));
      if (!targets.length) return;

      // 서버에 아직 행이 없는 것(로컬 메모·스트리밍 중)은 승격 경로를 타야 한다.
      const special = targets.filter((m) => {
        const b = before.get(m.id)!;
        return b._legacy || b._pending;
      });
      const plain = targets.filter((m) => {
        const b = before.get(m.id)!;
        return !b._legacy && !b._pending;
      });

      const byId = new Map(plain.map((m) => [m.id, m]));
      setItems((prev) =>
        prev.map((i) => {
          const m = byId.get(i.id);
          return m ? { ...i, x: m.x, y: m.y, pinned: true } : i;
        }),
      );
      for (const m of special) patch(m.id, { x: m.x, y: m.y, pinned: true });

      const rollback = () =>
        setItems((prev) => prev.map((i) => before.get(i.id) ?? i));

      void Promise.all(
        plain.map((m) => apiPatch(m.id, { x: m.x, y: m.y, pinned: true })),
      ).catch((e: Error) => {
        setError(`저장하지 못했습니다 — ${e.message}`);
        rollback();
      });

      // patch()가 special마다 되돌리기를 쌓았을 수 있다 — 마지막에 덮어써서
      // **전체를 한 번에** 되돌리게 한다.
      showUndo({
        label,
        run: () => {
          rollback();
          setUndo(null);
          void Promise.all(
            targets
              .filter((m) => isRealId(m.id))
              .map((m) => {
                const b = before.get(m.id)!;
                return apiPatch(m.id, { x: b.x, y: b.y, pinned: b.pinned });
              }),
          ).catch((e: Error) => setError(`되돌리지 못했습니다 — ${e.message}`));
        },
      });
    },
    [items, patch, showUndo],
  );

  const tagMany = useCallback(
    (ids: readonly string[], tag: string | null, label: string) => {
      const before = new Map<string, CanvasItem>();
      for (const id of ids) {
        const it = items.find((i) => i.id === id);
        if (it) before.set(id, it);
      }
      if (!before.size) return;

      // 서버에 아직 행이 없는 것은 승격 경로를 타야 한다(patch가 처리한다).
      const special = [...before.values()].filter((b) => b._legacy || b._pending);
      const plain = [...before.values()].filter((b) => !b._legacy && !b._pending);

      const touched = new Set(before.keys());
      setItems((prev) =>
        prev.map((i) =>
          touched.has(i.id) && !i._legacy && !i._pending
            ? { ...i, tag, _needsReflow: true }
            : i,
        ),
      );
      for (const b of special) patch(b.id, { tag }, { _needsReflow: true });

      const rollback = () =>
        setItems((prev) => prev.map((i) => before.get(i.id) ?? i));

      void Promise.all(plain.map((b) => apiPatch(b.id, { tag }))).catch((e: Error) => {
        setError(`저장하지 못했습니다 — ${e.message}`);
        rollback();
      });

      // patch()가 special마다 되돌리기를 쌓았을 수 있다 — 마지막에 덮어써서
      // **가지 전체를 한 번에** 되돌리게 한다.
      showUndo({
        label,
        run: () => {
          rollback();
          setUndo(null);
          void Promise.all(
            [...before.values()]
              .filter((b) => isRealId(b.id))
              .map((b) => apiPatch(b.id, { tag: b.tag })),
          ).catch((e: Error) => setError(`되돌리지 못했습니다 — ${e.message}`));
        },
      });
    },
    [items, patch, showUndo],
  );

  const patchMany = useCallback(
    (
      entries: readonly { id: string; patch: ItemPatch }[],
      label: string,
      opts?: { reflow?: boolean },
    ) => {
      const reflow = opts?.reflow ?? true;
      const before = new Map<string, CanvasItem>();
      for (const e of entries) {
        const it = items.find((i) => i.id === e.id);
        if (it) before.set(e.id, it);
      }
      const targets = entries.filter((e) => before.has(e.id));
      if (!targets.length) return;

      // 서버에 아직 행이 없는 것은 승격 경로(patch)가 처리한다.
      const special = targets.filter((e) => {
        const b = before.get(e.id)!;
        return b._legacy || b._pending;
      });
      const plain = targets.filter((e) => {
        const b = before.get(e.id)!;
        return !b._legacy && !b._pending;
      });

      const byId = new Map(plain.map((e) => [e.id, e.patch]));
      setItems((prev) =>
        prev.map((i) => {
          const p = byId.get(i.id);
          return p ? { ...i, ...toLocal(p), _needsReflow: reflow } : i;
        }),
      );
      for (const e of special) patch(e.id, e.patch, { _needsReflow: reflow });

      const rollback = () =>
        setItems((prev) => prev.map((i) => before.get(i.id) ?? i));

      void Promise.all(plain.map((e) => apiPatch(e.id, e.patch))).catch((err: Error) => {
        setError(`저장하지 못했습니다 — ${err.message}`);
        rollback();
      });

      showUndo({
        label,
        run: () => {
          rollback();
          setUndo(null);
          void Promise.all(
            targets
              .filter((e) => isRealId(e.id))
              .map((e) => {
                const b = before.get(e.id)!;
                // 되돌릴 값은 **바꾼 항목만** 되짚는다.
                const revert: ItemPatch = {};
                if (e.patch.tag !== undefined) revert.tag = b.tag;
                if (e.patch.parent_item_id !== undefined)
                  revert.parent_item_id = b.parentItemId;
                return apiPatch(e.id, revert);
              }),
          ).catch((err: Error) => setError(`되돌리지 못했습니다 — ${err.message}`));
        },
      });
    },
    [items, patch, showUndo],
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
      showUndo({
        label: "글을 지웠습니다",
        run: () => {
          setItems((prev) => insertAt(prev, { ...removed, _legacy: true }, index));
          setUndo(null);
        },
      });
    },
    [items, showUndo],
  );

  /**
   * 학생이 캔버스를 클릭해 만든 글.
   *
   * **곧바로 pinned다.** 학생이 그 자리를 골라서 클릭한 것이므로 배치 엔진이
   * 다른 데로 옮기면 안 된다.
   *
   * ## 서버에 바로 만들지 않는다
   *
   * 처음에는 즉시 POST했는데, 응답이 오면 임시 id가 서버 id로 바뀌면서
   * `editingId`가 가리키던 아이템이 사라진다 — **학생이 타이핑하는 중에
   * 입력창이 없어졌다**(실측). id를 안정적으로 유지하려고 붙잡는 것보다,
   * 저장 시점을 뒤로 미루는 편이 단순하고 부작용이 없다.
   *
   * `_legacy: true`로 만들어 로컬에만 둔다. 학생이 편집을 끝내면(blur) 그
   * patch가 승격 경로를 타면서 서버에 만들어진다. 부수 효과로 **빈 메모는
   * 아예 저장되지 않는다** — 캔버스를 잘못 클릭했다고 DB에 빈 행이 쌓이지
   * 않는다.
   */
  const createNote = useCallback(
    (sessionId: string, x: number, y: number, seq: number): string => {
      const id = `local-note-${Date.now()}`;
      setItems((prev) => [
        ...prev,
        {
          id,
          sessionId,
          nodeId: null,
          parentItemId: null,
          kind: "note",
          source: "user",
          title: null,
          body: "",
          tag: null,
          x,
          y,
          pinned: true,
          seq,
          data: {},
          _legacy: true, // 아직 서버에 없다 — 첫 편집이 승격시킨다
        },
      ]);
      return id;
    },
    [],
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
    replaceTemp,
    createNote,
    patch,
    moveMany,
    tagMany,
    patchMany,
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

/**
 * 아이템 id가 바뀌면 그를 부모로 가리키던 자식도 갱신한다.
 *
 * 임시 id(스트리밍) 또는 로컬 id(메모)가 서버 uuid로 승격될 때 부모 참조를
 * 함께 옮기지 않으면, 자식이 존재하지 않는 id를 가리켜 **연결선이 조용히
 * 사라진다.** 화면에는 오류가 없고 관계만 없어지므로 원인을 찾기 어렵다.
 */
function remapParents(
  list: CanvasItem[],
  oldIds: readonly string[],
  saved: readonly CanvasItem[],
): CanvasItem[] {
  const remap = new Map<string, string>();
  oldIds.forEach((old, i) => {
    const s = saved[i];
    if (s && s.id !== old) remap.set(old, s.id);
  });
  if (!remap.size) return list;
  return list.map((i) => {
    const next = i.parentItemId ? remap.get(i.parentItemId) : undefined;
    return next ? { ...i, parentItemId: next } : i;
  });
}

function insertAt(list: CanvasItem[], item: CanvasItem, index: number): CanvasItem[] {
  const next = [...list];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}
