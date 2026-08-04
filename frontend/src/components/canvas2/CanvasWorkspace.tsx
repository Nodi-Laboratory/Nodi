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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Undo2, X } from "lucide-react";
import { getCanvas, putDrawing } from "@/lib/api/canvas";
import { ApiError } from "@/lib/api/_core";
import type { DrawingScene } from "@/lib/api/canvas";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useSessionBinding } from "@/lib/canvas2/useSessionBinding";
import { useExcalidrawBridge } from "@/lib/canvas2/useExcalidrawBridge";
import { useCameraSpring } from "@/lib/canvas2/useCameraSpring";
import { useItemLayout, type LayoutSource } from "@/lib/canvas2/useItemLayout";
import { useCanvasItems } from "@/lib/canvas2/useCanvasItems";
import { sanitizeScene } from "@/lib/canvas2/sanitizeScene";
import { itemsFromNodes } from "@/lib/canvas2/legacyItems";
import { planHydration } from "@/lib/canvas2/hydration";
import { useCanvasStream } from "@/lib/canvas2/useCanvasStream";
import type { CanvasItem } from "@/lib/canvas2/types";
import { spaceTargetFromId } from "@/lib/api";
import { useSessionDetail } from "@/lib/queries";
import { intersects, union } from "@/lib/canvas2/rect";
import type { ResizeCommit } from "./ResizeHandles";
import { clearDragOffsets, setDragOffsets } from "@/lib/canvas2/dragBus";
import { ITEM_W, type Placed } from "@/lib/canvas2/layout";
import { focusCamera } from "@/lib/canvas2/focusCamera";
import type { Size } from "@/lib/canvas2/useItemLayout";
import { regroup, type RegroupItem } from "@/lib/canvas2/regroup";
import { useEventCallback } from "@/lib/canvas2/useEventCallback";
import { descendants, nextFocus, treeEdges } from "@/lib/canvas2/tree";
import { navigate, type NavDir } from "@/lib/canvas2/navigate";
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
import { CrossLinkLayer } from "./CrossLinkLayer";
import { useCrossLinks } from "@/lib/canvas2/useCrossLinks";
import type { CrossLink } from "@/lib/api";
import { SplitPrompt } from "./SplitPrompt";

interface Props {
  spaceId: string;
}

const FALLBACK_H = 180;

/**
 * 새 답이 생겼을 때의 배율 **상한** (D162, 사용자 지시: 235%).
 *
 * 읽으라고 만든 글이니 만들어지는 순간 읽을 수 있는 크기여야 한다. 다만
 * 고정값이 아니라 상한이다(D166) — 폭 560 카드는 235%에서 1316px이라
 * 교실 노트북에서는 화면보다 넓어 양쪽이 잘렸다. 잘린 큰 글씨는 안 읽힌다.
 */
const NEW_NODE_ZOOM = 2.35;

/**
 * 카드에 딸린 것(강의 클립·도판)까지 담느라 내려갈 수 있는 배율 하한 (D163).
 *
 * 235%를 고집하면 클립이 화면 밖이고, 무제한으로 축소하면 글을 못 읽는다.
 * 1.15배는 카드 하나 + 클립 셋이 들어오면서 본문이 기본 크기보다 큰 지점이다.
 */
const ATTACH_MIN_ZOOM = 1.15;
/** 묶음 둘레 여백(px). 화면 가장자리에 딱 붙으면 잘린 것처럼 보인다. */
const FOCUS_PAD = 72;
/**
 * 초점 계산에서 빼는 UI 자리 (D163 → D166).
 *
 * 뷰포트는 `<main>` 전체지만 그 위에 항상 떠 있는 것들이 있다 — 왼쪽 레일,
 * 오른쪽 도구 레일, 아래쪽 질문창, 위쪽 상단바. 그걸 세지 않고 배율을
 * 맞추면 딱 맞췄다고 계산한 아이템이 실제로는 그 밑에 깔린다.
 *
 * D163은 **딸린 것이 있을 때만** 뺐다. 잘리는 건 양쪽 다 마찬가지였으므로
 * (실측 2026-08-04: 카드 하나짜리 답의 줄마다 첫 글자가 왼쪽 레일에 가려
 * 있었다) 이제 두 갈래가 같은 여백을 쓴다.
 *
 * 개념 지도(오른쪽 위)는 빼지 않는다 — 접을 수 있고, 폭이 340이라 빼기
 * 시작하면 쓸 수 있는 자리가 확 줄어 오히려 더 축소된다.
 */
const UI_LEFT = 72;
const UI_TOP = 56;
const UI_RIGHT = 80;
const UI_BOTTOM = 150;

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
  // 교차 연결 이동 (D171) — 공간·세션을 함께 옮기고, 도착 후 초점을 맞춘다.
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const setReturnTo = useWorkspaceStore((s) => s.setReturnTo);
  const returnTo = useWorkspaceStore((s) => s.returnTo);
  const pendingFocusItemId = useWorkspaceStore((s) => s.pendingFocusItemId);
  const setPendingFocusItem = useWorkspaceStore((s) => s.setPendingFocusItem);
  const router = useRouter();
  const { sessionId, dropSession } = useSessionBinding(spaceId);

  /**
   * 선택된 아이템들. **집합이다** — 예전에는 하나뿐이라 올가미로 여럿을 잡아도
   * 마지막 하나만 남았다(사용자 지적: "선택 도구가 여러 요소를 선택할 수 없다").
   */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 학생이 **고른** 트리 노드 (D151). 선택(selectedIds)과 다른 개념이다.
   *
   * 선택은 옮기고 지우기 위한 것이고, 이건 "지금 이 가지에서 이어 묻는다"는
   * 뜻이다. 그래서 **끌면 고른 것이 아니다**(사용자 지시 2026-08-02:
   * "노드를 드래그하는건 그 노드를 선택한 것이 아니다") — 움직이지 않고 누른
   * 경우에만 잡힌다. 배경을 누르면 풀린다.
   */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** 가지 한가운데를 떼어내려는 중 — 아래를 어떻게 할지 묻는다 (D156). */
  const [split, setSplit] = useState<{ id: string; tag: string | null } | null>(null);
  /** 입력창에 커서를 옮겨 달라는 신호 (D157). "묻겠다"일 때만 올린다. */
  const [askFocus, setAskFocus] = useState(0);
  const queryClient = useQueryClient();

  useEffect(() => setActiveSpace(spaceId), [spaceId, setActiveSpace]);

  const { data: snapshot, error: snapshotError } = useQuery({
    queryKey: ["canvas", sessionId],
    queryFn: () => getCanvas(sessionId!),
    enabled: !!sessionId,
    staleTime: Infinity,
    // 캔버스는 사용자가 편집 중인 화면이다. 창을 다시 포커스했다고 서버
    // 스냅샷으로 덮으면 편집 중이던 위치가 되돌아간다.
    refetchOnWindowFocus: false,
  });

  /**
   * 잡고 있던 세션이 서버에서 사라졌으면 다시 고른다 (D153).
   *
   * 관리자가 데이터를 초기화하면 열려 있던 탭은 지워진 세션 id를 계속
   * 들고 있다. 그 상태에서는 `/canvas`도 `/chat`도 404라 **질문해도 아무
   * 일도 안 일어난다** — 학생 눈에는 "AI가 응답하지 않는다"로 보인다.
   * 새로고침하면 낫지만, 새로고침해야 낫는 화면은 고장난 화면이다.
   */
  useEffect(() => {
    if (snapshotError instanceof ApiError && snapshotError.status === 404) {
      dropSession();
    }
  }, [snapshotError, dropSession]);

  /**
   * 세션을 떠나면 그 스냅샷을 **캐시에서 버린다** (D147).
   *
   * 이 쿼리는 캐시가 아니라 **수화용 사진 한 장**이다. 찍은 뒤로 학생의
   * 편집(이동·수정·삭제)은 전부 서버로 나가지만 이 사진은 갱신되지 않는다.
   * 들고 있다가 재진입 때 다시 쓰면 옮겨 둔 좌표가 통째로 되돌아간다 —
   * 사용자가 겪은 "세션을 바꿨다 오면 원래 위치로 초기화"가 이것이다.
   * 버려 두면 돌아올 때 반드시 서버에서 새로 받는다.
   */
  useEffect(() => {
    if (!sessionId) return;
    return () => {
      queryClient.removeQueries({ queryKey: ["canvas", sessionId] });
    };
  }, [sessionId, queryClient]);

  // 구 세션 폴백 — v2 이전 세션에는 canvas_items가 한 행도 없다. 폴백이
  // 없으면 학생이 지난 대화를 열었을 때 빈 캔버스를 본다(데이터가 날아간
  // 것처럼 보인다). nodes.answer를 파싱해 읽기용으로 그리고, 첫 편집 때
  // 서버로 승격한다(legacyItems.ts 참조).
  const { data: detail, isPending: detailPending } = useSessionDetail(sessionId);

  /**
   * 이미 채워 넣은 세션 — **수화는 세션당 한 번이다** (D147).
   *
   * 그 뒤로는 화면의 글이 정본이다. 늦게 도착한 쿼리가 덮으면 학생이 옮긴
   * 자리가 사라지고, 더 나쁘게는 이미 저장된 글이 `_legacy` 복사본으로
   * 바뀌어 **다음 이동이 서버에 복제 행을 만든다**(hydration.ts 머리말).
   */
  const hydratedFor = useRef<string | null>(null);

  const { replaceAll } = store;
  useEffect(() => {
    const plan = planHydration({
      sessionId,
      hydratedFor: hydratedFor.current,
      snapshotCount: snapshot ? snapshot.items.length : null,
      detailPending,
    });
    if (plan.clear) {
      hydratedFor.current = null;
      replaceAll([]);
    }
    if (!plan.fill || !sessionId || !snapshot) return;
    hydratedFor.current = sessionId;
    replaceAll(
      plan.fill === "items"
        ? snapshot.items
        : itemsFromNodes(sessionId, detail?.nodes ?? []),
    );
  }, [sessionId, snapshot, detail, detailPending, replaceAll]);

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
  /**
   * 교차 세션 개념 연결 (D171). 연결은 워커가 턴 **뒤에** 만든다 —
   * 턴 안에서 돌리면 답이 늦어지고, 그건 "RAG는 채팅을 절대 막지 않는다"는
   * 불변식을 어긴다. 여기서는 조회와 표시만 한다.
   */
  const crossLinks = useCrossLinks(sessionId);
  const scheduleCrossCheck = crossLinks.scheduleCheck;

  const onPersisted = useCallback(
    (tempIds: string[], saved: CanvasItem[]) => {
      replaceTemp(tempIds, saved);
      // 카드가 서버에 들어간 뒤라야 워커가 그 id로 잡을 돌린다 (D171).
      scheduleCrossCheck();
    },
    [replaceTemp, scheduleCrossCheck],
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

  const hasClip = useCallback(
    (clipId: string) => store.items.some((i) => i.data.clip?.clipId === clipId),
    [store.items],
  );

  // 스트림이 새 카드의 부모를 정할 때 지금 캔버스에 뭐가 있는지 봐야 한다
  // (D151). 값이 아니라 함수로 준다 — 배열을 주면 스트리밍 중 글자 하나마다
  // `send`의 신원이 바뀐다.
  const getItems = useEventCallback(() => store.items);

  const stream = useCanvasStream({
    sessionId,
    getItems,
    onSessionGone: dropSession,
    upsertLocal,
    onPersisted,
    nextSeq,
    hasFigure,
    hasClip,
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
        // 트리 판정 (D151) — AI 개념 카드만 트리에 들어간다.
        kind: i.kind,
        source: i.source,
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

  const { patch, moveMany, tagMany, patchMany, remove, items } = store;
  const { setTool, clearElementSelection } = bridge;

  const onSelect = useEventCallback((id: string | null, additive?: boolean) => {
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
  });

  const onStartEdit = useEventCallback((id: string) => {
    setEditingId(id);
    setSelectedIds(new Set([id]));
  });

  const onCancelEdit = useEventCallback(() => setEditingId(null));

  const onCommitEdit = useEventCallback((id: string, body: string) => {
    setEditingId(null);
    // 내용이 그대로면 아무 일도 하지 않는다 — "위치 정리" 버튼이 괜히 뜬다.
    const cur = items.find((i) => i.id === id);
    if (!cur || cur.body === body) return;
    patch(id, { body }, { _needsReflow: true });
  });

  const onDelete = useEventCallback((id: string) => {
    if (editingId === id) setEditingId(null);
    if (pickedId === id) setPickedId(null);
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    remove(id);
  });

  /**
   * 분류를 바꾸면 **딸린 가지가 통째로 따라간다** — 트리 분리 (D151).
   *
   * 그 카드만 옮기면 자식들은 옛 태그를 그대로 갖고 있어 부모와 태그가
   * 달라지고, 간선 규칙에 따라 각자 뿌리로 **흩어진다.** 학생이 한 일은
   * "이 이야기를 따로 떼어 놓기"인데 결과가 "가지를 산산조각내기"가 되는
   * 셈이다. 가지째 옮기면 그 부분 트리가 통째로 새 트리가 된다.
   */
  const onTagChange = useEventCallback((id: string, tag: string | null) => {
    const kids = descendants(items, id);
    if (!kids.length) {
      patch(id, { tag }, { _needsReflow: true });
      return;
    }
    /**
     * 가지가 딸려 있고 **부모도 있으면** 학생에게 묻는다 (D156).
     *
     * 뿌리에는 이어 붙일 할아버지가 없어 고를 것이 하나뿐이다 — 그때는
     * 묻지 않고 가지째 옮긴다. 물을 것이 하나뿐이면 묻지 않는다.
     */
    const hasParent = treeEdges(items).some((e) => e.to === id);
    if (hasParent) {
      setSplit({ id, tag });
      return;
    }
    tagMany([id, ...kids], tag, `가지 ${kids.length + 1}개의 분류를 바꿨습니다`);
  });

  /** "자식 노드들도 같이 끊기" — 가지 전체가 새 트리가 된다. */
  const splitAll = useCallback(() => {
    if (!split) return;
    const kids = descendants(items, split.id);
    tagMany([split.id, ...kids], split.tag, `가지 ${kids.length + 1}개의 분류를 바꿨습니다`);
    setSplit(null);
  }, [split, items, tagMany]);

  /**
   * "자식 노드를 부모 노드에 연결하고 끊기" — 이 글만 빠진다.
   *
   * 바로 아래 자식만 할아버지에게 잇는다. 손자는 자기 부모를 그대로 따라가므로
   * 건드릴 필요가 없다.
   */
  const splitReattach = useCallback(() => {
    if (!split) return;
    const edges = treeEdges(items);
    const grandparent = edges.find((e) => e.to === split.id)?.from ?? null;
    const kids = edges.filter((e) => e.from === split.id).map((e) => e.to);
    patchMany(
      [
        { id: split.id, patch: { tag: split.tag } },
        ...kids.map((k) => ({ id: k, patch: { parent_item_id: grandparent } })),
      ],
      "이 글만 떼어 냈습니다",
    );
    setSplit(null);
  }, [split, items, patchMany]);

  /**
   * 드래그가 끝나면 학생이 정한 자리다 — 배치 엔진은 이제 이걸 읽기만 한다.
   *
   * 여럿이 선택돼 있고 그중 하나를 끌었으면 **전부 같은 양만큼** 옮긴다.
   * 화면에서는 이미 함께 움직였으므로(TextItem이 DOM을 직접 밀었다) 여기서
   * 좌표만 맞춰 주면 된다.
   */
  const onDragEnd = useEventCallback((id: string, x: number, y: number, dx: number, dy: number) => {
    /**
     * 끈 것 + 함께 고른 것 + **그 아래 가지 전부** (D154, 사용자 지시
     * 2026-08-02: "부모 노드를 드래그해서 움직이면 모든 자식 노드가 함께
     * 움직여야 해").
     *
     * 화면에서는 이미 함께 움직였다(TextItem이 DOM을 밀었다) — 여기서는
     * 좌표만 맞춰 준다. 한 항목으로 되돌릴 수 있게 `moveMany`를 쓴다:
     * patch를 반복하면 되돌리기가 마지막 하나만 남아 가지 하나만 제자리로 온다.
     */
    const roots = selectedIds.has(id) && selectedIds.size > 1 ? [...selectedIds] : [id];
    const all = new Set(roots);
    for (const r of roots) for (const d of descendants(items, r)) all.add(d);

    if (all.size === 1) {
      patch(id, { x, y, pinned: true });
      return;
    }
    const moves = [...all].flatMap((mid) => {
      if (mid === id) return [{ id: mid, x, y }];
      const p = layout.positions.get(mid);
      return p ? [{ id: mid, x: p.x + dx, y: p.y + dy }] : [];
    });
    moveMany(moves, roots.length > 1 ? "위치를 옮겼습니다" : "가지를 옮겼습니다");
  });

  /**
   * 손잡이로 정한 크기를 저장한다 (D142).
   *
   * 크기는 `data.size`다 — 좌표와 달리 배치 엔진의 입력이 아니라 렌더
   * 힌트고, 화면이 반영하면 ResizeObserver를 거쳐 배치가 알아서 따라온다.
   *
   * 왼쪽·위 손잡이로 줄이면 원점이 움직인다. 그때는 **드래그와 같은 취급**
   * 이다 — 학생이 자리를 정한 것이므로 pinned가 된다. 안 그러면 다음
   * 배치에서 열 흐름이 도로 끌어간다.
   */
  const onResize = useEventCallback((id: string, next: ResizeCommit) => {
    const cur = items.find((i) => i.id === id);
    const data = { ...cur?.data, size: { w: next.w, h: next.h } };
    if (!next.dx && !next.dy) {
      patch(id, { data });
      return;
    }
    const p = layout.positions.get(id);
    patch(id, {
      data,
      x: (p?.x ?? cur?.x ?? 0) + next.dx,
      y: (p?.y ?? cur?.y ?? 0) + next.dy,
      pinned: true,
    });
  });

  const onResetSize = useEventCallback((id: string) => {
    const cur = items.find((i) => i.id === id);
    if (!cur?.data.size) return;
    const rest = { ...cur.data };
    delete rest.size;
    patch(id, { data: rest });
  });

  /**
   * "위치 정리" — **고정을 푼다** (D161).
   *
   * 예전에는 빈 자리를 직접 찾아 그 좌표에 다시 고정했다(`reflowOne`). 그
   * 함수는 열이 고정 피치라는 전제 위에 있었는데, tidy tree(D159)에서 열 x는
   * **누적**이라 그 계산이 엉뚱한 자리를 냈다.
   *
   * 지금은 배치 엔진이 트리 모양을 스스로 만든다. 그러니 "정리"의 뜻은
   * 하나뿐이다 — **엔진에게 맡긴다.** 고정을 풀면 다음 배치에서 제자리를
   * 찾아간다. 계산이 두 곳에 있지 않으니 어긋날 자리도 없다.
   */
  const onReflow = useEventCallback((id: string) => {
    patch(id, { pinned: false }, { _needsReflow: false });
  });

  const onDismissReflow = useEventCallback((id: string) => {
    const cur = items.find((i) => i.id === id);
    patch(
      id,
      { data: { ...cur?.data, reflowDismissed: true } },
      { _needsReflow: false },
    );
  });

  /**
   * "다시 질문하기" — 이 노드를 골라 둔다 (D149 → D151).
   *
   * 고르는 것 자체가 기능이다. 버튼은 그 지름길일 뿐이고, 노드를 그냥 눌러도
   * 같은 일이 일어난다(사용자 지시 2026-08-02: "그 노드를 클릭하고 질문하면
   * 자연스럽게 작동").
   */
  const onAsk = useEventCallback((id: string) => {
    setPickedId(id);
    // 버튼을 눌렀다는 것은 "지금 묻겠다"는 뜻이다 — 커서를 입력창으로.
    setAskFocus((n) => n + 1);
  });

  /**
   * 노드를 **끌지 않고 눌렀다** — 그 가지에서 이어 묻겠다는 뜻이다 (D151).
   *
   * AI 개념 카드만 고를 수 있다. 학생 메모나 도판을 고르면 이어 붙일 트리가
   * 없어서 아무 일도 일어나지 않는데, 골라진 것처럼 보이면 거짓말이 된다.
   */
  const onPick = useEventCallback((id: string | null) => {
    if (!id) {
      setPickedId(null);
      return;
    }
    const it = items.find((i) => i.id === id);
    setPickedId(it && it.kind === "concept" && it.source === "ai" ? id : null);
  });

  /**
   * 핸들러 묶음. 안의 함수가 전부 신원 고정이라 **이 객체도 고정**이고,
   * 그래서 `memo(TextItem)`이 실제로 일한다 (D145).
   *
   * 예전에는 여기에 `items`·`layout`·`selectedIds`가 의존성으로 들어 있었다.
   * 그 중 하나만 바뀌어도 묶음이 새 객체가 되고, 그걸 받는 **모든** 아이템의
   * memo가 깨진다 — 실측으로 글 하나를 클릭할 때 128회 렌더됐다.
   *
   * ⚠️ 여기에 매 프레임 바뀌는 값(bridge 등)을 **다시 넣지 마라.** bridge는
   * camera를 deps로 가진 useMemo라 팬/줌 중 매 프레임 새 객체가 된다 —
   * v1이 정확히 그래서 느렸다(useItemLayout.ts 머리말 참조).
   */
  const handlers = useMemo(
    () => ({
      onSelect,
      onStartEdit,
      onCancelEdit,
      onCommitEdit,
      onDelete,
      onTagChange,
      onDragEnd,
      onResize,
      onResetSize,
      onReflow,
      onDismissReflow,
      onAsk,
      onPick,
    }),
    [onSelect, onStartEdit, onCancelEdit, onCommitEdit, onDelete, onTagChange, onDragEnd, onResize, onResetSize, onReflow, onDismissReflow, onAsk, onPick],
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
    // 빈 곳을 눌렀으면 어느 가지에서도 이어 묻지 않는다는 뜻이다 (D151).
    setPickedId(null);
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

  /**
   * 재배치 — 태그 무리를 최소한으로 움직여 서로 갈라 놓는다 (D143).
   *
   * 열 배치를 다시 돌리는 것이 아니다. 지금 자리를 출발점으로 삼으므로
   * 학생이 정리해 둔 모양이 남고, **이미 잘 나뉘어 있으면 아무것도 움직이지
   * 않는다.** 옮긴 자리는 학생이 정한 것과 같은 취급(pinned)이다.
   *
   * 그림(캔버스 도구) 요소는 보지 않는다(사용자 지시).
   *
   * @returns 실제로 옮겼나. 호출부가 "이미 나뉘어 있다"를 알려 준다.
   */
  const handleRegroup = useCallback((): boolean => {
    const input: RegroupItem[] = items.map((i) => {
      const p = layout.positions.get(i.id);
      const size = layout.sizes.get(i.id);
      return {
        id: i.id,
        tag: i.tag,
        parentItemId: i.parentItemId,
        x: p?.x ?? i.x,
        y: p?.y ?? i.y,
        w: size?.w ?? ITEM_W,
        h: size?.h ?? FALLBACK_H,
      };
    });
    const { moves } = regroup(input);
    if (!moves.size) return false;
    moveMany(
      [...moves].map(([id, at]) => ({ id, x: at.x, y: at.y })),
      "재배치했습니다",
    );
    return true;
  }, [items, layout, moveMany]);

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

  /**
   * 트리 걷기 (D157) — 고른 노드로 가고, 카메라를 그 자리로 옮긴다.
   *
   * **배율은 그대로 둔다.** 한 걸음마다 확대·축소가 바뀌면 어디를 보고 있는지
   * 감각이 끊긴다. 지도에서 고른 것과는 다르다 — 그쪽은 "이걸 읽겠다"이고
   * 이쪽은 "둘러보겠다"이다.
   */
  const goToNode = useCallback(
    (id: string | null) => {
      if (!id) return;
      setPickedId(id);
      const p = layout.positions.get(id);
      if (!p) return;
      const size = layout.sizes.get(id) ?? { w: ITEM_W, h: FALLBACK_H };
      const { w, h } = viewport();
      const z = cameraRef.current.zoom;
      flyTo({
        zoom: z,
        scrollX: w / 2 / z - (p.x + size.w / 2),
        scrollY: h / 2 / z - (p.y + size.h / 2),
      });
    },
    [layout, cameraRef, flyTo],
  );

  /**
   * 교차 연결이 가리키는 과거 대화로 이동한다 (D171).
   *
   * **세션만 바꾸면 안 된다.** 세션은 공간에 속하므로(D148) 공간까지 함께
   * 옮기지 않으면 학급 공간에서 개인 세션이 열린다 — 남의 공간에서 남의 글을
   * 편집할 수 있게 됐던 그 사고다.
   *
   * 도착해서 바로 초점을 맞출 수는 없다. 목적지 세션은 아직 안 채워져 있고
   * 수화는 비동기이며 세션당 한 번이다(D147). 그래서 "가서 이 카드를 보여
   * 달라"를 스토어에 남기고, 캔버스가 그 카드를 실제로 갖게 됐을 때 소비한다.
   *
   * 돌아올 자리도 남긴다 — 어제 세션에 던져 놓고 끝내면 학생은 길을 잃는다.
   */
  const goToPastConversation = useEventCallback((link: CrossLink) => {
    const targetSpace =
      link.to.spaceKind === "class" && link.to.spaceRef
        ? link.to.spaceRef
        : "personal";
    if (sessionId) {
      setReturnTo({
        sessionId,
        spaceId,
        itemId: link.fromItemId,
      });
    }
    setPendingFocusItem(link.to.itemId);
    setActiveSpace(targetSpace);
    setActiveSession(link.to.sessionId, targetSpace);
    if (targetSpace !== spaceId) router.push(`/space/${targetSpace}`);
  });

  /** 원래 보던 곳으로. 갈 때와 **같은 규칙**으로 공간·세션을 함께 옮긴다. */
  const returnToOrigin = useEventCallback(() => {
    if (!returnTo) return;
    const { sessionId: sid, spaceId: sp, itemId } = returnTo;
    setReturnTo(null);
    setPendingFocusItem(itemId);
    setActiveSpace(sp);
    setActiveSession(sid, sp);
    if (sp !== spaceId) router.push(`/space/${sp}`);
  });

  /**
   * 남겨 둔 초점 요청을 소비한다. 그 카드를 **실제로 갖게 된 뒤**라야 한다 —
   * 배치가 아직 없으면 goToNode가 조용히 아무것도 안 한다.
   *
   * **한 프레임 미룬다.** 이펙트 본문에서 바로 옮기면 두 가지가 겹친다:
   * React Compiler가 금지하는 이펙트 내 동기 setState이고(억제하지 않고
   * 구조로 푼다), 그보다 실질적으로는 **아직 안 잰 크기로 카메라를 계산한다**.
   * 아이템 높이는 그려진 뒤에 측정되므로(layout.measure), 페인트 뒤에 옮겨야
   * 카드가 화면 가운데에 온다.
   */
  useEffect(() => {
    if (!pendingFocusItemId) return;
    if (!layout.positions.has(pendingFocusItemId)) return;
    const id = requestAnimationFrame(() => {
      goToNode(pendingFocusItemId);
      setPendingFocusItem(null);
    });
    return () => cancelAnimationFrame(id);
  }, [pendingFocusItemId, layout.positions, goToNode, setPendingFocusItem]);

  const navGo = useEventCallback((dir: NavDir) => {
    goToNode(navigate(items, layout.tagOrder, pickedId, dir));
  });

  /**
   * 방향키. **입력 중에는 절대 가로채지 않는다** — 질문을 쓰다 커서를 옮기려고
   * ←를 눌렀는데 화면이 다른 트리로 날아가면 안 된다(도구 단축키와 같은 규칙).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) {
        return;
      }
      const dir =
        e.key === "ArrowUp"
          ? "up"
          : e.key === "ArrowDown"
            ? "down"
            : e.key === "ArrowLeft"
              ? "left"
              : e.key === "ArrowRight"
                ? "right"
                : null;
      if (!dir) return;
      e.preventDefault();
      // Excalidraw도 방향키로 도형을 옮긴다 — 전파를 끊어야 둘이 겹치지 않는다.
      e.stopPropagation();
      navGo(dir);
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [navGo]);

  /**
   * 입력창에 붙는 인용 칩 — **고른 노드에서 파생한다** (D151).
   *
   * 예전에는 `quote` state가 따로 있었다. 고른 노드와 인용이 두 곳에 살면
   * 반드시 어긋난다(노드를 지웠는데 칩이 남는 식). 하나만 두고 파생시킨다.
   */
  const pickedItem = useMemo(
    () => items.find((i) => i.id === pickedId) ?? null,
    [items, pickedId],
  );
  const quote = useMemo(
    () =>
      pickedItem
        ? {
            id: pickedItem.id,
            tag: pickedItem.tag,
            text: (pickedItem.title?.trim() || pickedItem.body).slice(0, 200),
          }
        : null,
    [pickedItem],
  );

  /**
   * 질문을 보내고, 답이 붙은 자리로 초점을 옮긴다 (D151).
   *
   * 초점을 그대로 두면 이어 물을수록 같은 노드에서 형제가 옆으로 쌓인다.
   * 학생이 기대하는 것은 방금 받은 답 **뒤에** 이어지는 것이다.
   */
  const handleSend = useCallback(
    (question: string) => {
      const from = pickedId;
      const tag = pickedItem?.tag ?? null;
      void stream.send(question, { pickedId: from }).then((created) => {
        setPickedId(nextFocus(from, tag, created));
      });
    },
    [pickedId, pickedItem, stream],
  );

  /**
   * 지도에서 무언가를 누르면 **그것이 화면을 채우도록** 옮긴다 (D155).
   *
   * 예전에는 중심 좌표만 옮기고 배율은 그대로였다. 축소해 놓고 지도를 보다
   * 노드를 누르면 여전히 깨알 같은 글자 앞에 서 있게 된다 — 지도에서 고른
   * 이유는 그걸 **읽으려는** 것이다(사용자 지시 2026-08-02: "그 노드가
   * 화면에 엄청 크게 보이도록 확대해서 이동").
   *
   * 배율은 그 사각형이 여백을 두고 들어가는 값으로 잡되 2.5배를 넘지
   * 않는다(그 이상은 글자가 뭉개진다). 작은 노드 하나를 눌러도 화면을
   * 가득 채운다.
   */
  const handleMinimapFocus = useCallback(
    (r: { x: number; y: number; w: number; h: number }) => {
      const { w, h } = viewport();
      const pad = 120;
      const zoom = Math.min(
        2.5,
        Math.max(0.2, Math.min((w - pad) / Math.max(1, r.w), (h - pad) / Math.max(1, r.h))),
      );
      flyTo(cameraForRect(r, { w, h }, zoom));
    },
    [flyTo],
  );

  /**
   * 도형을 끄는 동안 **함께 선택된 우리 글도 같이 옮긴다** (D120).
   *
   * Excalidraw가 도형을 옮기는 사이 우리 글이 제자리에 남으면, 함께 골라 놓고
   * 움직였는데 절반만 따라오는 셈이다. 아이템 드래그와 같은 방식으로 —
   * 끄는 동안은 DOM transform만 고치고(React를 거치면 60fps에 버벅인다),
   * 손을 뗄 때 한 번 저장한다.
   */
  const handleShapeDrag = useCallback(
    (dx: number, dy: number, done: boolean) => {
      if (!selectedIds.size) return;
      /**
       * 도형과 함께 끌 때도 **가지가 따라온다** (D161).
       *
       * 글을 직접 끌 때는 자손이 함께 갔는데(D154) 이 경로만 빠져 있었다.
       * 같은 동작이 어디서 시작했느냐에 따라 다르게 굴면 학생은 규칙을
       * 배울 수 없다.
       */
      const roots = [...selectedIds];
      const withKids = new Set(roots);
      for (const r of roots) for (const d of descendants(items, r)) withKids.add(d);
      const ids = [...withKids];
      if (!done) {
        const shift = `translate(${dx}px, ${dy}px)`;
        for (const id of ids) {
          const el = document.querySelector<HTMLElement>(
            `[data-canvas-item="${CSS.escape(id)}"]`,
          );
          if (!el) continue;
          el.style.transition = "none";
          el.style.transform = shift;
        }
        setDragOffsets(ids, dx, dy);
        return;
      }
      clearDragOffsets();
      for (const id of ids) {
        const el = document.querySelector<HTMLElement>(
          `[data-canvas-item="${CSS.escape(id)}"]`,
        );
        if (el) el.style.transition = "";
      }
      // 움직이지 않았으면(그냥 클릭) 저장할 것이 없다.
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      for (const id of ids) {
        const pos = layout.positions.get(id);
        if (!pos) continue;
        patch(id, { x: pos.x + dx, y: pos.y + dy, pinned: true });
      }
    },
    [selectedIds, items, layout, patch],
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
   * 답이 생긴 자리로 카메라를 옮긴다 — **크게 당겨서** (D162).
   *
   * 스트림은 좌표를 모르므로 id만 알려 주고, **배치가 좌표를 낸 뒤** 여기서
   * 옮긴다. 아이템 위쪽을 화면 상단 1/3에 두는데, 정중앙에 두면 글이 아래로
   * 자라면서 곧 화면을 벗어난다.
   *
   * 배율은 그때의 값을 쓰지 않고 `NEW_NODE_ZOOM`까지 당긴다(사용자 지시
   * 2026-08-03: "노드를 생성하면 그 노드가 아주 크게 보이게 확대"). 축소해
   * 놓고 질문하면 답이 깨알같이 생겨서 정작 읽지를 못했다. 다만 **상한**이라
   * 카드가 화면보다 넓어지면 그만큼 물러선다(D166) — 잘린 큰 글씨는 아예
   * 안 읽힌다.
   */
  const { focusId, clearFocus } = stream;
  const storeItems = store.items;
  useEffect(() => {
    if (!focusId) return;
    const p = layout.positions.get(focusId);
    if (!p) return; // 아직 배치 전 — 다음 렌더에 다시 시도한다

    /**
     * 이 카드에 딸린 것(강의 클립·교과서 도판)까지 화면에 넣는다 (D163).
     *
     * 235%에서 폭 560 카드는 화면을 꽉 채운다 — 옆에 아무리 잘 놓아도 안
     * 보인다. 딸린 것이 있을 때만 배율을 낮춰 묶음을 담는다(focusCamera).
     */
    const attached = storeItems.filter(
      (i) => i.parentItemId === focusId && (i.kind === "clip" || i.kind === "figure"),
    );
    // 아직 실측 전인 첨부가 있으면 기다린다. 폴백 크기로 날아가면 카메라가
    // 한 번 어긋난 자리에 서고, focus는 이미 지워져 다시 맞출 기회가 없다.
    if (attached.some((a) => !layout.positions.has(a.id) || !layout.sizes.has(a.id))) return;

    const size = layout.sizes.get(focusId) ?? { w: ITEM_W, h: FALLBACK_H };
    flyTo(
      focusCamera(
        { x: p.x, y: p.y, w: size.w, h: size.h },
        attached.map((a) => {
          const ap = layout.positions.get(a.id) as Placed;
          const as = layout.sizes.get(a.id) as Size;
          return { x: ap.x, y: ap.y, w: as.w, h: as.h };
        }),
        // 딸린 것이 있든 없든 같은 여백을 본다 (D166).
        {
          w: vp.w,
          h: vp.h,
          left: UI_LEFT,
          right: UI_RIGHT,
          top: UI_TOP,
          bottom: UI_BOTTOM,
        },
        { maxZoom: NEW_NODE_ZOOM, minZoom: ATTACH_MIN_ZOOM, pad: FOCUS_PAD },
      ),
    );
    clearFocus();
  }, [focusId, layout.positions, layout.sizes, storeItems, vp, flyTo, clearFocus]);

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
      onShapeDrag={handleShapeDrag}
      chrome={
        <>
          {/* 교차 연결로 과거 대화에 들어왔을 때만 뜬다 (D171).
              어제 세션에 던져 놓고 끝내면 학생은 길을 잃는다 — 원래 보던
              곳으로 한 번에 돌아갈 수 있어야 한다. 지금 세션이 곧 돌아갈
              세션이면 이미 도착한 것이므로 숨긴다. */}
          {returnTo && returnTo.sessionId !== sessionId ? (
            <button
              type="button"
              onClick={returnToOrigin}
              className="pointer-events-auto absolute left-1/2 top-16 z-20 flex -translate-x-1/2
                         items-center gap-1.5 rounded-full border border-accent-border/60
                         bg-bg-elevated px-3 py-1.5 text-xs font-medium text-accent-deep
                         shadow-md transition-colors hover:bg-accent/10"
            >
              <Undo2 size={13} />
              원래 보던 곳으로
            </button>
          ) : null}
          <CanvasTopBar
            title={sessionTitle}
            zoom={bridge.camera.zoom}
            onOpenSessions={() => setDrawerOpen(true)}
            onZoom={handleZoom}
            onFit={handleFit}
            onRegroup={handleRegroup}
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
          {split &&
            (() => {
              const it = items.find((i) => i.id === split.id);
              if (!it) return null;
              return (
                <SplitPrompt
                  title={(it.title?.trim() || it.body).slice(0, 30)}
                  kidCount={descendants(items, split.id).length}
                  tag={split.tag}
                  onDetachAll={splitAll}
                  onReattach={splitReattach}
                  onCancel={() => setSplit(null)}
                />
              );
            })()}
          {store.undo && <UndoToast label={store.undo.label} onUndo={store.undo.run} />}
          <Minimap
            items={items}
            positions={layout.positions}
            sizes={layout.sizes}
            tagOrder={layout.tagOrder}
            camera={bridge.camera}
            viewport={vp}
            pickedId={pickedId}
            onFocus={handleMinimapFocus}
          />
          <div className="ui absolute bottom-[152px] left-1/2 z-30 w-[min(680px,calc(100%-140px))] -translate-x-1/2">
            <SessionFilesBar sessionId={sessionId} uploadError={uploadError} />
          </div>
          <AskBar
            onAttach={handleAttach}
            busy={stream.busy}
            reply={stream.reply}
            quote={quote}
            disabled={!sessionId}
            focusSignal={askFocus}
            onClearQuote={() => setPickedId(null)}
            onSend={handleSend}
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
        pickedId={pickedId}
        measure={layout.measure}
        handlers={handlers}
      />
      <CrossLinkLayer
        links={crossLinks.links}
        positions={layout.positions}
        sizes={layout.sizes}
        onOpen={crossLinks.markOpened}
        onNavigate={goToPastConversation}
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
