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
import { itemsFromNodes } from "@/lib/canvas2/legacyItems";
import { useCanvasStream } from "@/lib/canvas2/useCanvasStream";
import type { CanvasItem } from "@/lib/canvas2/types";
import { spaceTargetFromId } from "@/lib/api";
import { useSessionDetail } from "@/lib/queries";
import { intersects, union } from "@/lib/canvas2/rect";
import { ITEM_W } from "@/lib/canvas2/layout";
import { cameraForRect } from "@/lib/canvas2/useCameraSpring";
import SessionDrawer from "@/components/canvas/SessionDrawer";
import SessionFilesBar from "@/components/canvas/SessionFilesBar";
import { uploadFile } from "@/lib/api";
import { sessionFilesKey } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { AskBar } from "./AskBar";
import { CanvasTopBar } from "./CanvasTopBar";
import { Minimap } from "./Minimap";
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

/**
 * 창 크기를 따라가는 뷰포트.
 *
 * 값으로 들고 있어야 미니맵이 좁은 화면에서 접힌다 — 매 렌더 `viewport()`를
 * 부르는 것만으로는 리사이즈 때 리렌더가 나지 않는다(교실 태블릿의 화면
 * 회전이 정확히 그 경우다).
 */
function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState(() => ({ w: 1200, h: 800 }));
  useEffect(() => {
    const read = () => {
      const next = viewport();
      setVp((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
    };
    read();
    window.addEventListener("resize", read);
    const el = document.querySelector("main");
    const ro = el ? new ResizeObserver(read) : null;
    if (el && ro) ro.observe(el);
    return () => {
      window.removeEventListener("resize", read);
      ro?.disconnect();
    };
  }, []);
  return vp;
}

export function CanvasWorkspace({ spaceId }: Props) {
  const bridge = useExcalidrawBridge();
  // 스프링은 아이템으로 카메라를 옮길 때 쓴다(전체 보기·확대/축소).
  // 초기 카메라는 여기 쓰지 않는다 — ExcalidrawLayer의 initialData가 맡는다.
  const spring = useCameraSpring(bridge);
  const store = useCanvasItems();
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const { sessionId } = useSessionBinding(spaceId);

  /**
   * 선택된 아이템들. **집합이다** — 예전에는 하나뿐이라 올가미로 여럿을 잡아도
   * 마지막 하나만 남았다(사용자 지적: "선택 도구가 여러 요소를 선택할 수 없다").
   */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ id: string; text: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const queryClient = useQueryClient();

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

  // 구 세션 폴백 — v2 이전 세션에는 canvas_items가 한 행도 없다. 폴백이
  // 없으면 학생이 지난 대화를 열었을 때 빈 캔버스를 본다(데이터가 날아간
  // 것처럼 보인다). nodes.answer를 파싱해 읽기용으로 그리고, 첫 편집 때
  // 서버로 승격한다(legacyItems.ts 참조).
  const { data: detail } = useSessionDetail(sessionId);

  const { replaceAll } = store;
  useEffect(() => {
    if (!snapshot || !sessionId) return;
    if (snapshot.items.length) {
      replaceAll(snapshot.items);
      return;
    }
    const nodes = detail?.nodes ?? [];
    replaceAll(nodes.length ? itemsFromNodes(sessionId, nodes) : []);
  }, [snapshot, detail, sessionId, replaceAll]);

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

  const hasFigure = useCallback(
    (figureId: string) =>
      store.items.some((i) => i.data.figure?.figureId === figureId),
    [store.items],
  );

  const stream = useCanvasStream({
    sessionId,
    upsertLocal,
    onPersisted,
    nextSeq,
    hasFigure,
  });

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

  const { patch, remove, items, addChildNote } = store;
  const { getObstacles: getObs, setTool, clearElementSelection } = bridge;

  const handlers = useMemo(
    () => ({
      onSelect: (id: string | null, additive?: boolean) => {
        // **그냥 클릭은 교체다** — 도형 선택도 함께 비운다. 안 그러면 글 하나만
        // 골랐는데 아까 잡아 둔 도형이 계속 잡혀 있어, 지우거나 옮길 때 딸려
        // 온다. Shift일 때는 더하는 것이므로 저쪽 선택을 건드리지 않는다.
        if (!additive) clearElementSelection();
        setSelectedIds((prev) => {
          if (!id) return prev.size ? new Set<string>() : prev;
          if (!additive) return prev.size === 1 && prev.has(id) ? prev : new Set([id]);
          const next = new Set(prev);
          // Shift는 토글이다 — 잘못 넣은 하나를 빼려고 다시 누르는 게 자연스럽다.
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      },

      onStartEdit: (id: string) => {
        setEditingId(id);
        setSelectedIds(new Set([id]));
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
        setSelectedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        remove(id);
      },

      onTagChange: (id: string, tag: string | null) => {
        patch(id, { tag }, { _needsReflow: true });
      },

      /**
       * 드래그가 끝나면 학생이 정한 자리다 — 배치 엔진은 이제 이걸 읽기만 한다.
       *
       * 여럿이 선택돼 있고 그중 하나를 끌었으면 **전부 같은 양만큼** 옮긴다.
       * 화면에서는 이미 함께 움직였으므로(TextItem이 DOM을 직접 밀었다) 여기서
       * 좌표만 맞춰 주면 된다.
       */
      onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => {
        if (!selectedIds.has(id) || selectedIds.size <= 1) {
          patch(id, { x, y, pinned: true });
          return;
        }
        for (const sid of selectedIds) {
          if (sid === id) {
            patch(sid, { x, y, pinned: true });
            continue;
          }
          const p = layout.positions.get(sid);
          if (!p) continue;
          patch(sid, { x: p.x + dx, y: p.y + dy, pinned: true });
        }
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
          width: layout.sizes.get(i.id)?.w ?? ITEM_W,
          height: layout.sizes.get(i.id)?.h ?? FALLBACK_H,
          parentItemId: i.parentItemId,
        });
        const spot = reflowOne(
          toInput(target),
          items.filter((i) => i.id !== id).map(toInput),
          getObs(),
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

      /**
       * 인출 연습 결과를 캔버스에 남긴다 (D138).
       *
       * 학생이 쓴 회상은 **그 카드의 자식 글**이 된다 — 배치가 옆에 놓고
       * 연결선이 이어 준다. 사라지면 산출물이 아니고, 다음에 이 카드를 볼 때
       * "내가 그때 이만큼 기억했구나"가 함께 보여야 의미가 있다.
       *
       * `askHidden`을 켜 둔다: 이건 이미 학생이 스스로 쓴 글이라 "AI에게 묻기"를
       * 권할 자리가 아니다.
       */
      onRecall: (id: string, text: string) => {
        if (!sessionId) return;
        void addChildNote(sessionId, id, text, nextSeq());
      },
    }),
    // ⚠️ **bridge 전체를 넣으면 안 된다.** bridge는 camera를 deps로 가진
    // useMemo라 팬/줌 중 매 프레임 새 객체가 되고, 그러면 handlers도 매 프레임
    // 새로 생겨 memo(TextItem)이 무력화된다 — 전 아이템이 60fps로 리렌더된다
    // (v1이 정확히 이 이유로 느렸다: useItemLayout.ts 헤더 주석 참조).
    // getObstacles는 [api]에만 의존하므로 안정적이다.
    [items, patch, remove, editingId, selectedIds, layout, getObs, sessionId, addChildNote, nextSeq, clearElementSelection],
  );

  /**
   * 빈 곳 클릭 — 선택 해제. 편집 중이면 편집도 끝낸다.
   *
   * **먼저 blur를 시킨다.** 그냥 `setEditingId(null)`만 하면 textarea가
   * 언마운트되면서 쓰던 내용이 통째로 사라진다 — 사용자가 지적한 "입력하다가
   * 중간에 배경을 클릭해도 자동으로 저장되도록" 이 지점이다. blur는 동기라
   * 아래 setState보다 먼저 onCommit이 돌고, 그 안에서 본문이 저장된다.
   */
  const handleBackgroundClick = useCallback(() => {
    document
      .querySelector<HTMLTextAreaElement>('textarea[aria-label="본문 수정"]')
      ?.blur();
    setSelectedIds((prev) => (prev.size ? new Set<string>() : prev));
    setEditingId(null);
  }, []);

  /**
   * 올가미 — 사각형에 **조금이라도 걸친** 것을 고른다 (사용자 지시 2026-07-31:
   * "요소의 일부만 들어가도 선택에 포함되도록", "모든 요소가 동일하게 선택").
   *
   * 한때 Excalidraw와 규칙을 맞추려고 완전 포함으로 뒀는데, 긴 문단을 고르려면
   * 화면을 다 덮도록 끌어야 해서 실제로 쓰기 나빴다.
   *
   * **글과 도형이 같은 규칙을 쓴다.** Excalidraw의 올가미는 완전 포함이라
   * 그대로 두면 같은 드래그가 글은 잡고 도형은 놓친다. 저쪽 판정을 바꿀 수는
   * 없으므로 선택 **결과**를 우리가 계산해 덮어쓴다(`bridge.selectElementsIn`).
   */
  const { selectElementsIn } = bridge;
  const handleMarquee = useCallback(
    (rect: { x: number; y: number; w: number; h: number }, add: boolean) => {
      const hit = items
        .filter((i) => {
          const p = layout.positions.get(i.id);
          if (!p) return false;
          const s = layout.sizes.get(i.id) ?? { w: ITEM_W, h: FALLBACK_H };
          return intersects(rect, { x: p.x, y: p.y, w: s.w, h: s.h });
        })
        .map((i) => i.id);
      setSelectedIds((prev) => (add ? new Set([...prev, ...hit]) : new Set(hit)));
      setEditingId(null);
      selectElementsIn(rect, add);
    },
    [items, layout, selectElementsIn],
  );

  // 글쓰기 도구로 빈 곳 클릭 → 그 자리에 빈 글을 만들고 바로 편집 모드로.
  // 클릭한 자리가 곧 학생이 고른 자리이므로 pinned로 태어난다.
  const { createNote } = store;
  const handleCreateNote = useCallback(
    (world: { x: number; y: number }) => {
      if (!sessionId) return;
      const id = createNote(sessionId, world.x, world.y, nextSeq());
      setSelectedIds(new Set([id]));
      setEditingId(id);
      // 글을 하나 놓았으면 계속 놓고 싶지는 않다 — 선택 도구로 돌아간다.
      setTool("selection");
    },
    [sessionId, createNote, nextSeq, setTool],
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
        const s = layout.sizes.get(i.id) ?? { w: ITEM_W, h: FALLBACK_H };
        return { x: p.x, y: p.y, w: s.w, h: s.h };
      })
      .filter((r): r is NonNullable<typeof r> => !!r);
    const box = union([...rects, ...getObstacles()]);
    if (!box) return;
    const { w, h } = viewport();
    const pad = 140;
    const zoom = Math.min(1.2, Math.max(0.2, Math.min((w - pad) / box.w, (h - pad) / box.h)));
    flyTo(cameraForRect(box, { w, h }, zoom));
  }, [items, layout, getObstacles, flyTo]);

  const vp = useViewport();

  const handleMinimapJump = useCallback(
    (world: { x: number; y: number }) => {
      const { w, h } = viewport();
      const z = cameraRef.current.zoom;
      flyTo({ zoom: z, scrollX: w / 2 / z - world.x, scrollY: h / 2 / z - world.y });
    },
    [cameraRef, flyTo],
  );

  const target = useMemo(() => spaceTargetFromId(spaceId), [spaceId]);
  const sessionTitle = detail?.session?.title?.trim() || "새 대화";

  // 세션 컨텍스트 파일 첨부 (D83) — 업로드 후 칩 바가 상태를 보여 준다.
  const handleAttach = useCallback(
    (file: File) => {
      if (!sessionId) return;
      setUploadError(null);
      void uploadFile(target, file, { kind: "user_upload", session_id: sessionId })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: sessionFilesKey(sessionId) }),
        )
        .catch((e: Error) => setUploadError(e.message));
    },
    [sessionId, target, queryClient],
  );

  /**
   * 답이 생긴 자리로 카메라를 옮긴다 (사용자 지적).
   *
   * 스트림은 좌표를 모르므로 id만 알려 주고, **배치가 좌표를 낸 뒤** 여기서
   * 옮긴다. 아이템 위쪽을 화면 상단 1/3에 두는데, 정중앙에 두면 글이 아래로
   * 자라면서 곧 화면을 벗어난다.
   */
  const { focusId, clearFocus } = stream;
  useEffect(() => {
    if (!focusId) return;
    const p = layout.positions.get(focusId);
    if (!p) return; // 아직 배치 전 — 다음 렌더에 다시 시도한다
    const { w, h: vh } = vp;
    const z = cameraRef.current.zoom;
    flyTo({
      zoom: z,
      scrollX: w / 2 / z - (p.x + ITEM_W / 2),
      scrollY: vh / 3 / z - p.y,
    });
    clearFocus();
  }, [focusId, layout.positions, vp, cameraRef, flyTo, clearFocus]);

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
      onMarquee={handleMarquee}
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
          {/* **비었다고 말하기 전에 비었는지 알아야 한다.**
              `items.length === 0`만 보면 불러오는 동안에도 "여기에 답이
              펼쳐집니다"가 뜬다 — 글이 20개 든 세션을 열어도 몇 초간
              빈 캔버스라고 말하는 셈이다(실측: 191ms부터 4초 내내).
              세션이 잡히고 스냅샷이 도착한 뒤에만 판단한다. */}
          {!!sessionId && !!snapshot && items.length === 0 && <EmptyHint />}
          {banner && <SaveBanner message={banner} onClose={store.clearError} />}
          {store.undo && <UndoToast label={store.undo.label} onUndo={store.undo.run} />}
          <Minimap
            items={items}
            positions={layout.positions}
            sizes={layout.sizes}
            tagOrder={layout.tagOrder}
            camera={bridge.camera}
            viewport={vp}
            onJump={handleMinimapJump}
          />
          <div className="ui absolute bottom-28 left-1/2 z-30 w-[min(680px,calc(100%-140px))] -translate-x-1/2">
            <SessionFilesBar sessionId={sessionId} uploadError={uploadError} />
          </div>
          <AskBar
            onAttach={handleAttach}
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
      <ItemLayer
        items={store.items}
        positions={layout.positions}
        sizes={layout.sizes}
        columnX={layout.columnX}
        tagOrder={layout.tagOrder}
        tagOptions={store.tagOptions}
        zoom={bridge.camera.zoom}
        selectedIds={selectedIds}
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
        style={{ background: "var(--c-on-dark)" }}
      >
        <Undo2 size={13} />
        되돌리기
      </button>
    </div>
  );
}

/**
 * 빈 캔버스 안내.
 *
 * **화면 고정 UI다**(변환 평면 밖). 평면 안에 두면 카메라 초기 위치에 따라
 * 화면 밖으로 나가서, 정작 아무것도 없을 때 안내가 안 보인다.
 */
function EmptyHint() {
  return (
    <div
      className="ui pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 select-none text-center"
      style={{ color: "var(--c-ink-faint)" }}
    >
      <p className="text-[15px]">아래에 질문을 적으면 여기에 답이 펼쳐집니다.</p>
      <p className="mt-1 text-[13px]">오른쪽 도구로 직접 쓰고 그릴 수도 있습니다.</p>
    </div>
  );
}
