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
import { useCanvasStream } from "@/lib/canvas2/useCanvasStream";
import type { CanvasItem } from "@/lib/canvas2/types";
import { spaceTargetFromId } from "@/lib/api";
import { useSessionDetail } from "@/lib/queries";
import { union } from "@/lib/canvas2/rect";
import { ITEM_W } from "@/lib/canvas2/layout";
import { cameraForRect } from "@/lib/canvas2/useCameraSpring";
import SessionDrawer from "@/components/canvas/SessionDrawer";
import { AskBar } from "./AskBar";
import { CanvasTopBar } from "./CanvasTopBar";
import { CanvasStage } from "./CanvasStage";
import { ItemLayer } from "./ItemLayer";

interface Props {
  spaceId: string;
}

const FALLBACK_H = 180;

/**
 * 초기 카메라. 좌·상단 여유를 둬서 열 라벨(아이템 위 34px)과 좌측 괘선(-16px)이
 * 사이드바에 가려지지 않게 한다. 세션이 바뀌면 sceneKey로 그리기 레이어가
 * 리마운트되며 다시 적용된다 — 이전 세션의 화면 위치를 물고 오면 학생이 빈
 * 공간을 본다.
 */
const INITIAL_CAMERA = { scrollX: 180, scrollY: 150, zoom: 1 };

/** 뷰포트 크기. 캔버스는 사이드바를 뺀 <main> 안에 있다. */
function viewport(): { w: number; h: number } {
  const el = typeof document !== "undefined" ? document.querySelector("main") : null;
  return {
    w: el?.clientWidth ?? 1200,
    h: el?.clientHeight ?? 800,
  };
}

export function CanvasWorkspace({ spaceId }: Props) {
  const bridge = useExcalidrawBridge();
  // 스프링은 아이템으로 카메라를 옮길 때 쓴다(전체 보기·확대/축소).
  // 초기 카메라는 여기 쓰지 않는다 — ExcalidrawLayer의 initialData가 맡는다.
  const spring = useCameraSpring(bridge);
  const store = useCanvasItems();
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const { sessionId } = useSessionBinding(spaceId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ id: string; text: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  // --- 스트림 ----------------------------------------------------------------

  const { upsertLocal, replaceTemp } = store;

  // 임시 id로 그려 둔 아이템을 서버가 준 진짜 행으로 갈아 끼운다.
  // 갈아 끼우지 않으면 그 아이템은 영영 로컬 전용이라 편집·삭제가 서버에 안 간다.
  const onPersisted = useCallback(
    (tempIds: string[], saved: CanvasItem[]) => replaceTemp(tempIds, saved),
    [replaceTemp],
  );

  const nextSeq = useCallback(
    () => (store.items.length ? Math.max(...store.items.map((i) => i.seq)) + 1 : 0),
    [store.items],
  );

  const stream = useCanvasStream({ sessionId, upsertLocal, onPersisted, nextSeq });

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

      // 학생 글 → 그 내용이 인용된 채 입력창이 열린다(D126).
      onAsk: (id: string) => {
        const it = items.find((i) => i.id === id);
        if (it) setQuote({ id, text: it.body.slice(0, 200) });
      },

      onDismissAsk: (id: string) => {
        const cur = items.find((i) => i.id === id);
        patch(id, { data: { ...cur?.data, askHidden: true } });
      },
    }),
    [items, patch, remove, editingId, selectedId, layout, bridge],
  );

  // 빈 곳 클릭 — 선택 해제. 편집 중이면 편집도 끝낸다.
  const handleBackgroundClick = useCallback(() => {
    setSelectedId(null);
    setEditingId(null);
  }, []);

  // 글쓰기 도구로 빈 곳 클릭 → 그 자리에 빈 글을 만들고 바로 편집 모드로.
  // 클릭한 자리가 곧 학생이 고른 자리이므로 pinned로 태어난다.
  const { createNote } = store;
  const handleCreateNote = useCallback(
    (world: { x: number; y: number }) => {
      if (!sessionId) return;
      const id = createNote(sessionId, world.x, world.y, nextSeq());
      setSelectedId(id);
      setEditingId(id);
      // 글을 하나 놓았으면 계속 놓고 싶지는 않다 — 선택 도구로 돌아간다.
      bridge.setTool("selection");
    },
    [sessionId, createNote, nextSeq, bridge],
  );

  // 화면 배율 — 뷰포트 중앙을 기준으로 확대·축소한다(커서 기준은 휠이 맡는다).
  const { flyTo } = spring;
  const { cameraRef, getObstacles } = bridge;
  const handleZoom = useCallback(
    (factor: number) => {
      const c = cameraRef.current;
      const { w, h } = viewport();
      const next = Math.min(2.5, Math.max(0.2, c.zoom * factor));
      // 화면 중앙의 world 점을 고정한 채 배율만 바꾼다.
      const cx = w / 2 / c.zoom - c.scrollX;
      const cy = h / 2 / c.zoom - c.scrollY;
      flyTo({ zoom: next, scrollX: w / 2 / next - cx, scrollY: h / 2 / next - cy });
    },
    [cameraRef, flyTo],
  );

  const handleFit = useCallback(() => {
    const rects = items
      .map((i) => {
        const p = layout.positions.get(i.id);
        if (!p) return null;
        return { x: p.x, y: p.y, w: ITEM_W, h: layout.heights.get(i.id) ?? FALLBACK_H };
      })
      .filter((r): r is NonNullable<typeof r> => !!r);
    const box = union([...rects, ...getObstacles()]);
    if (!box) return;
    const { w, h } = viewport();
    const pad = 140;
    const zoom = Math.min(1.2, Math.max(0.2, Math.min((w - pad) / box.w, (h - pad) / box.h)));
    flyTo(cameraForRect(box, { w, h }, zoom));
  }, [items, layout, getObstacles, flyTo]);

  const target = useMemo(() => spaceTargetFromId(spaceId), [spaceId]);
  const { data: detail } = useSessionDetail(sessionId);
  const sessionTitle = detail?.session?.title?.trim() || "새 대화";

  const banner =
    drawError ??
    store.error ??
    stream.error ??
    (cleaned && cleaned.dropped > 0
      ? `그림 요소 ${cleaned.dropped}개를 읽지 못해 건너뛰었습니다`
      : null);

  return (
    <CanvasStage
      bridge={bridge}
      sceneKey={sceneKey}
      initialCamera={INITIAL_CAMERA}
      initialScene={initialScene}
      onSceneCommit={handleSceneCommit}
      onCanvasClick={handleCreateNote}
      onBackgroundClick={handleBackgroundClick}
      chrome={
        <>
          <CanvasTopBar
            title={sessionTitle}
            zoom={bridge.camera.zoom}
            onOpenSessions={() => setDrawerOpen(true)}
            onZoom={handleZoom}
            onFit={handleFit}
          />
          <SessionDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            target={target}
          />
          {banner && <SaveBanner message={banner} onClose={store.clearError} />}
          {store.undo && <UndoToast label={store.undo.label} onUndo={store.undo.run} />}
          <AskBar
            busy={stream.busy}
            reply={stream.reply}
            quote={quote}
            disabled={!sessionId}
            onClearQuote={() => setQuote(null)}
            onSend={(q, parentItemId) => void stream.send(q, { parentItemId })}
          />
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
