"use client";

/**
 * 캔버스 v2 오케스트레이터. `ConceptCanvasWorkspace`(397줄)를 대체한다.
 *
 * v1과의 책임 분담 차이:
 *
 *   v1  콘텐츠=useConceptStream · 좌표=useTagLayout(d3-force) · 카메라=이 컴포넌트
 *   v2  콘텐츠=useCanvasItems · 좌표=useItemLayout(결정론 배치) · 카메라=useCameraSpring
 *       뷰포트(팬/줌)=Excalidraw  ← 우리가 더 이상 소유하지 않는다
 *
 * 여기가 하는 일은 **연결**뿐이다 — 렌더는 ItemLayer, 배치는 layout.ts,
 * 저장은 useCanvasItems가 한다.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Undo2, X } from "lucide-react";
import { getCanvas, putDrawing } from "@/lib/api/canvas";
import type { DrawingScene } from "@/lib/api/canvas";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useSessionBinding } from "@/lib/canvas2/useSessionBinding";
import { useExcalidrawBridge } from "@/lib/canvas2/useExcalidrawBridge";
import { useCameraSpring } from "@/lib/canvas2/useCameraSpring";
import { useItemLayout, type LayoutSource } from "@/lib/canvas2/useItemLayout";
import { useCanvasItems } from "@/lib/canvas2/useCanvasItems";
import { reflowOne, type LayoutInput } from "@/lib/canvas2/layout";
import { sanitizeScene } from "@/lib/canvas2/sanitizeScene";
import { CanvasStage } from "./CanvasStage";
import { ItemLayer } from "./ItemLayer";

interface Props {
  spaceId: string;
}

const FALLBACK_H = 180;

export function CanvasWorkspace({ spaceId }: Props) {
  const bridge = useExcalidrawBridge();
  const spring = useCameraSpring(bridge);
  const store = useCanvasItems();
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const { sessionId } = useSessionBinding(spaceId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);

  useEffect(() => setActiveSpace(spaceId), [spaceId, setActiveSpace]);

  const { data: snapshot } = useQuery({
    queryKey: ["canvas", sessionId],
    queryFn: () => getCanvas(sessionId!),
    enabled: !!sessionId,
    staleTime: Infinity,
    // 캔버스는 사용자가 편집 중인 화면이다. 창을 다시 포커스했다고 서버
    // 스냅샷으로 덮으면 편집 중이던 위치가 되돌아간다.
    refetchOnWindowFocus: false,
  });

  const { replaceAll } = store;
  useEffect(() => {
    if (snapshot) replaceAll(snapshot.items);
  }, [snapshot, replaceAll]);

  // 그림은 마운트 시 1회만 밀어 넣는다(`initialData`가 그때만 읽힌다).
  // sceneKey는 씬이 도착한 뒤에야 생긴다 — sessionId로 키를 잡으면 세션 전환
  // 직후(쿼리 응답 전) null 씬으로 마운트돼 그림이 영영 안 뜬다.
  const sceneKey = snapshot && sessionId ? sessionId : null;
  // 깨진 요소 하나가 캔버스 전체를 죽이지 않게 거른다(sanitizeScene 참조).
  const cleaned = useMemo(
    () => (snapshot ? sanitizeScene(snapshot.drawing.elements) : null),
    [snapshot],
  );
  const initialScene = useMemo(
    () =>
      cleaned && snapshot
        ? { elements: cleaned.elements, files: snapshot.drawing.files }
        : null,
    [cleaned, snapshot],
  );

  const commitScene = useCallback(
    (scene: DrawingScene) => {
      if (!sessionId) return;
      void putDrawing(sessionId, scene)
        .then(() => setDrawError(null))
        .catch((e: Error) => setDrawError(e.message));
    },
    [sessionId],
  );

  // --- 배치 ------------------------------------------------------------------

  const layoutSources: LayoutSource[] = useMemo(
    () =>
      store.items.map((i) => ({
        id: i.id,
        tag: i.tag,
        seq: i.seq,
        pinned: i.pinned,
        x: i.x,
        y: i.y,
        parentItemId: i.parentItemId,
      })),
    [store.items],
  );

  const layout = useItemLayout(sessionId, layoutSources, bridge.getObstacles);

  // 그림을 그린 직후 배치를 다시 돌린다 — 새 선이 장애물이 됐을 수 있다.
  const { invalidate } = layout;
  const handleSceneCommit = useCallback(
    (scene: DrawingScene) => {
      commitScene(scene);
      invalidate();
    },
    [commitScene, invalidate],
  );

  // --- 조작 ------------------------------------------------------------------

  const { patch, remove, items } = store;

  const handlers = useMemo(
    () => ({
      onSelect: (id: string | null) => setSelectedId(id),

      onStartEdit: (id: string) => {
        setEditingId(id);
        setSelectedId(id);
      },

      onCancelEdit: () => setEditingId(null),

      onCommitEdit: (id: string, body: string) => {
        setEditingId(null);
        // 내용이 그대로면 아무 일도 하지 않는다 — "위치 정리" 버튼이 괜히 뜬다.
        const cur = items.find((i) => i.id === id);
        if (!cur || cur.body === body) return;
        patch(id, { body }, { _needsReflow: true });
      },

      onDelete: (id: string) => {
        if (editingId === id) setEditingId(null);
        if (selectedId === id) setSelectedId(null);
        remove(id);
      },

      onTagChange: (id: string, tag: string | null) => {
        patch(id, { tag }, { _needsReflow: true });
      },

      // 드래그가 끝나면 학생이 정한 자리다 — 배치 엔진은 이제 이걸 읽기만 한다.
      onDragEnd: (id: string, x: number, y: number) => {
        patch(id, { x, y, pinned: true });
      },

      onReflow: (id: string) => {
        const target = items.find((i) => i.id === id);
        if (!target) return;
        const toInput = (i: (typeof items)[number]): LayoutInput => ({
          id: i.id,
          tag: i.tag,
          seq: i.seq,
          pinned: i.pinned,
          // 다른 아이템의 "현재 자리"는 배치 결과다 — 원본 x/y가 아니다.
          x: layout.positions.get(i.id)?.x ?? i.x,
          y: layout.positions.get(i.id)?.y ?? i.y,
          height: layout.heights.get(i.id) ?? FALLBACK_H,
          parentItemId: i.parentItemId,
        });
        const spot = reflowOne(
          toInput(target),
          items.filter((i) => i.id !== id).map(toInput),
          bridge.getObstacles(),
          layout.tagOrder,
        );
        // 정리 결과도 고정이다. 안 그러면 다음 배치에서 열 흐름이 다시 옮긴다.
        patch(id, { x: spot.x, y: spot.y, pinned: true }, { _needsReflow: false });
      },

      onDismissReflow: (id: string) => {
        const cur = items.find((i) => i.id === id);
        patch(
          id,
          { data: { ...cur?.data, reflowDismissed: true } },
          { _needsReflow: false },
        );
      },

      onAsk: (id: string) => {
        // P4에서 AskBar로 연결한다.
        console.debug("[canvas2] AI에게 묻기", id);
      },

      onDismissAsk: (id: string) => {
        const cur = items.find((i) => i.id === id);
        patch(id, { data: { ...cur?.data, askHidden: true } });
      },
    }),
    [items, patch, remove, editingId, selectedId, layout, bridge],
  );

  // 빈 곳을 클릭하면 선택 해제. 편집 중이면 편집도 끝낸다.
  const handleCanvasClick = useCallback(() => {
    setSelectedId(null);
    setEditingId(null);
  }, []);

  // 세션이 바뀌면 카메라를 원점으로. 이전 세션의 화면 위치를 물고 오면
  // 학생이 빈 공간을 보게 된다.
  const { jumpTo } = spring;
  useEffect(() => {
    jumpTo({ scrollX: 120, scrollY: 120, zoom: 1 });
  }, [sessionId, jumpTo]);

  const banner =
    drawError ??
    store.error ??
    (cleaned && cleaned.dropped > 0
      ? `그림 요소 ${cleaned.dropped}개를 읽지 못해 건너뛰었습니다`
      : null);

  return (
    <CanvasStage
      key={sceneKey ?? "none"}
      bridge={bridge}
      initialScene={initialScene}
      onSceneCommit={handleSceneCommit}
      onCanvasClick={handleCanvasClick}
      chrome={
        <>
          {banner && <SaveBanner message={banner} onClose={store.clearError} />}
          {store.undo && <UndoToast label={store.undo.label} onUndo={store.undo.run} />}
        </>
      }
    >
      {!sessionId && <EmptyHint />}
      <ItemLayer
        items={store.items}
        positions={layout.positions}
        heights={layout.heights}
        columnX={layout.columnX}
        tagOrder={layout.tagOrder}
        tagOptions={store.tagOptions}
        zoom={bridge.camera.zoom}
        selectedId={selectedId}
        editingId={editingId}
        measureRef={layout.measureRef}
        handlers={handlers}
      />
    </CanvasStage>
  );
}

/**
 * 저장 실패를 조용히 넘기지 않는다.
 *
 * 화면은 계속 쓸 수 있어야 하지만 **실패했다는 사실은 반드시 보여야 한다.**
 * 학생이 30분 작업한 걸 잃고 나서 아는 상황을 만들지 않는다.
 */
function SaveBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div
      data-no-pan
      className="ui absolute left-1/2 top-4 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border px-3 py-2 text-sm"
      style={{
        background: "var(--c-raised)",
        color: "var(--c-danger)",
        borderColor: "var(--c-rule)",
        boxShadow: "var(--c-shadow-md)",
      }}
      role="status"
    >
      {message}
      <button type="button" onClick={onClose} aria-label="닫기" style={{ opacity: 0.6 }}>
        <X size={14} />
      </button>
    </div>
  );
}

function UndoToast({ label, onUndo }: { label: string; onUndo: () => void }) {
  return (
    <div
      data-no-pan
      className="ui absolute bottom-24 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border px-4 py-2 text-sm"
      style={{
        background: "var(--c-ink)",
        color: "var(--c-paper)",
        borderColor: "transparent",
        boxShadow: "var(--c-shadow-lg)",
      }}
      role="status"
    >
      {label}
      <button
        type="button"
        onClick={onUndo}
        className="flex items-center gap-1 rounded-full px-2 py-0.5 font-medium"
        style={{ background: "rgba(255,255,255,.14)" }}
      >
        <Undo2 size={13} />
        되돌리기
      </button>
    </div>
  );
}

function EmptyHint() {
  return (
    <div
      className="ui pointer-events-none absolute select-none"
      style={{ left: 0, top: 0, color: "var(--c-ink-faint)" }}
    >
      <p className="text-[15px]">아래에 질문을 적으면 여기에 답이 펼쳐집니다.</p>
      <p className="mt-1 text-[13px]">오른쪽 도구로 직접 쓰고 그릴 수도 있습니다.</p>
    </div>
  );
}
