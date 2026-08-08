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
// ⚠️ lucide의 `Map`을 그대로 들이면 **전역 `Map` 생성자를 가린다**
// (`new Map<string, Rect>()`가 통째로 타입 오류가 된다). 이름을 바꾼다.
import { Map as MapIcon, Undo2, X } from "lucide-react";
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
import type { ItemPatch } from "@/lib/api/canvas";
import type { Candidate } from "@/lib/canvas2/detachDrag";
import type { EditContext, EditResult } from "@/lib/canvas2/useItemDrag";
import type { CanvasItem, ToolName } from "@/lib/canvas2/types";
import type { ExcalidrawElementLike } from "@/lib/canvas2/useExcalidrawBridge";
import { spaceTargetFromId } from "@/lib/api";
import { useSessionDetail } from "@/lib/queries";
import { intersects, union, type Rect } from "@/lib/canvas2/rect";
import type { ResizeCommit } from "./ResizeHandles";
import { clearDragOffsets, setDragOffsets } from "@/lib/canvas2/dragBus";
import { ITEM_W, type Placed } from "@/lib/canvas2/layout";
import { backOffCamera, focusCamera, type Camera } from "@/lib/canvas2/focusCamera";
import type { Size } from "@/lib/canvas2/useItemLayout";
import { regroup, type RegroupItem } from "@/lib/canvas2/regroup";
import { useEventCallback } from "@/lib/canvas2/useEventCallback";
import { MiniMapOverlay } from "@/components/canvas2/MiniMapOverlay";
import { useCardPush } from "@/lib/canvas2/useCardPush";
import { usePortLink } from "@/lib/canvas2/usePortLink";
import { descendants, groupSizes, isTreeNode, nextFocus, treeEdges } from "@/lib/canvas2/tree";
import { slowMove } from "@/lib/canvas2/moveEase";
import { idRemap, remapId, remapIdSet } from "@/lib/canvas2/idRemap";
import { useQuestionCoach } from "@/lib/canvas2/useQuestionCoach";
import { CoachBubble } from "./CoachBubble";
import { navigate, type NavDir } from "@/lib/canvas2/navigate";
import { cameraForRect } from "@/lib/canvas2/useCameraSpring";
import SessionDrawer from "@/components/canvas/SessionDrawer";
import SessionFilesBar from "@/components/canvas/SessionFilesBar";
import { uploadFile } from "@/lib/api";
import { checkUploadFile } from "@/lib/uploadLimits";
import { sessionFilesKey } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { useCanvasTouchGuard } from "@/lib/canvas2/penGuard";
import {
  allAskStrokes,
  markAsk,
  pendingStrokes,
  toStrokes,
  withoutStrokes,
} from "@/lib/canvas2/askInk";
import { renderInkPng } from "@/lib/canvas2/penPad";
import {
  captureInk,
  EMPTY_CAPTURE,
  type InkCapture,
} from "@/lib/canvas2/inkCapture";
import { interpretInk, ocrErrorMessage } from "@/lib/api";
import { AskBar, type AskBarHandle } from "./AskBar";
import { CanvasTopBar } from "./CanvasTopBar";
import { CanvasStage } from "./CanvasStage";
import { ItemLayer } from "./ItemLayer";
import { CrossLinkLayer } from "./CrossLinkLayer";
import { useCrossLinks } from "@/lib/canvas2/useCrossLinks";
import { useClientSettings } from "@/lib/canvas2/useClientSettings";
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
// D174: 기본값. 실제 값은 관리자 설정에서 온다(useClientSettings).
const NEW_NODE_ZOOM = 2.35;

/**
 * 카드에 딸린 것(강의 클립·도판)까지 담느라 내려갈 수 있는 배율 하한 (D163).
 *
 * 235%를 고집하면 클립이 화면 밖이고, 무제한으로 축소하면 글을 못 읽는다.
 * 1.15배는 카드 하나 + 클립 셋이 들어오면서 본문이 기본 크기보다 큰 지점이다.
 */
const ATTACH_MIN_ZOOM = 1.15;
/**
 * 자라는 카드에서 물러날 때 **아래에 남길 화면 비율** (D210 2-2).
 *
 * 꽉 맞추면 다 보여도 답답하고, 스트리밍 중에는 곧 이어질 문단이 들어설
 * 자리가 없어 보인다.
 */
const GROW_HEADROOM = 0.18;
/** 물러날 때 카드 위에 남길 여백(px). 위쪽은 화면에 붙인다. */
const GROW_TOP_PAD = 40;
/**
 * 물러남의 하한 (D210 2-2).
 *
 * 아주 긴 답에서 무한히 축소되면 글자를 못 읽는다. 여기 닿으면 그만 줄이고
 * 카드 **위쪽**을 화면에 붙인 채로 둔다 — 읽기는 위에서 시작하므로 잘리는
 * 쪽은 아래여야 한다.
 */
const GROW_MIN_ZOOM = 0.75;

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
  /**
   * 자라는 카드를 따라가는 중인지 (D210 2-2).
   *
   * `cam`은 **우리가 마지막으로 정한 목표**다. 살아 있는 카메라로 넘침을
   * 재면 날아가는 도중의 중간 배율로 판정해 목표가 계속 흔들린다 — 목표끼리
   * 견주면 배율이 단조 감소라 흔들릴 자리가 없다.
   */
  const growRef = useRef<{ id: string; cam: Camera } | null>(null);
  const spring = useCameraSpring(bridge, {
    // 학생이 직접 확대·이동했으면 자동 조정을 멈춘다. 읽으려고 당겨 놓은
    // 화면을 카메라가 되돌리면 그게 더 큰 방해다(사용자 지시).
    onHijack: useCallback(() => {
      growRef.current = null;
    }, []),
  });
  const store = useCanvasItems();
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  // 교차 연결 이동 (D176) — 공간·세션을 함께 옮기고, 도착 후 초점을 맞춘다.
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const setReturnTo = useWorkspaceStore((s) => s.setReturnTo);
  const setMapSnapshot = useWorkspaceStore((s) => s.setMapSnapshot);
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
  /**
   * 질문 필기의 단계 (D176).
   *
   *   null      평소
   *   "writing" 질문하는 펜으로 캔버스에 쓰는 중 — 버튼은 [글자 인식]
   *   "review"  인식이 끝나 글자가 입력창에 들어옴 — [다시 쓰기] [AI에게 묻기]
   *
   * 도구 선택(`bridge.activeTool`)과 **따로 둔다**: 인식이 끝난 뒤에도 도구는
   * 질문하는 펜인 채로 두어야 "다시 쓰기"가 곧바로 이어진다.
   */
  const [inkRecognized, setInkRecognized] = useState(false);
  const [inkCount, setInkCount] = useState(0);
  const [inkBusy, setInkBusy] = useState(false);
  /**
   * 방금 읽은 펜 표시 (D178) — **다음에 보낼 질문 한 번에만** 실린다.
   *
   * 입력창의 글자와 따로 두는 이유: 저장되는 질문은 학생이 쓴 것 그대로여야
   * 툴팁(`askedQuestion`)과 기록이 맞는다. 표시 설명을 거기 이어 붙이면
   * 저장된 질문이 벽이 된다.
   */
  const [inkContext, setInkContext] = useState<{
    marksNote: string;
    cardIds: string[];
    /** 기하가 센 짚은 카드 번호. 서버 프롬프트가 단정문으로 쓴다. */
    pointed: number[];
    /**
     * 학생이 짚은 카드의 **아이템 id** — 이 턴의 답이 그 카드의 자식이 된다.
     *
     * 여럿을 짚었으면 **첫 번째**만 부모로 쓴다(D151: 부모는 최대 하나).
     * 개념 카드가 아니면(도판·클립) 비운다 — 이어 붙일 트리가 없다.
     */
    parentId: string | null;
  } | null>(null);
  /**
   * 질문하는 펜을 **켠 순간** 캔버스에 있던 획들.
   *
   * 표시를 찍을 때만 쓴다 — "지금부터 그은 것"을 가려내는 용도다. 판정 자체는
   * 표시(`customData.nodiAsk`)가 하므로, 이 집합이 사라져도 이미 찍힌 질문
   * 획은 계속 질문 획이다. 이걸 안 두면 앞서 **일반 펜으로 그린 그림에까지**
   * 표시가 찍힌다(실측 2026-08-05: 질문 1획 + 그림 1획인데 2획이 아니라
   * 3획으로 셌다).
   */
  const markBaseRef = useRef<ReadonlySet<string>>(new Set());
  const askBarRef = useRef<AskBarHandle>(null);
  // 펜을 쓰는 동안 손날이 만든 click을 화면 전체에서 삼킨다 (D176).
  useCanvasTouchGuard();
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
   * 교차 세션 개념 연결 (D176). 연결은 워커가 턴 **뒤에** 만든다 —
   * 턴 안에서 돌리면 답이 늦어지고, 그건 "RAG는 채팅을 절대 막지 않는다"는
   * 불변식을 어긴다. 여기서는 조회와 표시만 한다.
   */
  // D174: 캔버스 화면 동작 값(확대 배율·간격 등)은 관리자가 정한다.
  const clientSettings = useClientSettings();
  const crossLinks = useCrossLinks(sessionId);
  const scheduleCrossCheck = crossLinks.scheduleCheck;

  const onPersisted = useCallback(
    (tempIds: string[], saved: CanvasItem[]) => {
      replaceTemp(tempIds, saved);
      /**
       * **id를 가리키는 상태도 함께 옮긴다** (D187).
       *
       * `replaceTemp`는 아이템 배열과 부모 참조만 옮긴다. 그런데 초점·선택·
       * 편집은 여기(워크스페이스) state라 그대로 남고, 임시 id를 가리킨 채
       * **허공을 가리키게 된다.**
       *
       *   초점(pickedId)   인용 칩이 파생값이라(D151) **칩이 사라진다.**
       *                    학생이 이어 묻던 자리를 잃고, 그대로 보내면 답이
       *                    엉뚱한 가지에 붙는다.
       *   선택(selectedIds) 끌기·지우기가 조용히 아무것도 안 한다.
       *   편집(editingId)  쓰던 입력창이 닫힌다.
       *
       * 실측 2026-08-06: 답이 뜨자마자 카드를 누르면 초점은 `tmp-1`인데 저장
       * 뒤 화면에는 UUID만 남아 칩이 없어졌다. **화면에도 로그에도 안 드러난다** —
       * 학생 눈에는 "눌렀는데 표시가 없어졌다"뿐이다.
       *
       * `createNote`가 같은 결함을 만나 **저장을 뒤로 미뤄** 피한 적이 있다
       * (useCanvasItems.createNote docstring — "타이핑하는 중에 입력창이
       * 없어졌다"). 스트리밍 카드는 그 수를 못 쓴다: 답이 끝나면 반드시
       * 저장해야 하므로, id가 갈리는 **이 지점에서** 옮기는 것이 옳다.
       */
      const moved = idRemap(tempIds, saved);
      if (moved.size) {
        setPickedId((cur) => remapId(cur, moved));
        setEditingId((cur) => remapId(cur, moved));
        setSelectedIds((cur) => remapIdSet(cur, moved));
      }
      // 카드가 서버에 들어간 뒤라야 워커가 그 id로 잡을 돌린다 (D176).
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

  /**
   * 카드마다 **이어진 묶음이 몇 장인가** (D210 6-2).
   *
   * 새 분류를 만들 수 있는지가 여기서 갈린다 — 한 장짜리는 아직 "다른 갈래"가
   * 아니라 그냥 옮긴 카드다. 배치가 쓰는 것과 **같은 목록**으로 센다: 화면에
   * 선이 보이는데 "혼자"라고 판정하면 그건 학생 눈에 고장이다.
   */
  const groupSize = useMemo(() => groupSizes(layoutSources), [layoutSources]);

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
    patch(id, { body });
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
    // 열이 바뀐다 — 감속하며 건너가야 무슨 일이 있었는지 보인다 (D210 6-3).
    slowMove();
    const kids = descendants(items, id);
    if (!kids.length) {
      patch(id, { tag });
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
    slowMove();
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
    slowMove();
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
  /**
   * 태그 이름 변경 — 그 태그를 단 **모든 카드**에 반영한다 (D147).
   *
   * 사용자 결정(2026-08-02): 수정은 이 카드 하나가 아니라 분류 자체를 고치는
   * 일이다. 열 라벨도 `canvas_items.tag`가 소스라 함께 바뀐다.
   *
   * 옛 구현은 자기만의 일괄 저장 경로(`retag` + `pendingPatches`)를 들고
   * 있었는데, 지금은 `tagMany`가 같은 일을 **한 번의 요청**으로 한다(D183) —
   * 되돌리기도 한 항목이다. 되살리면서 그쪽에 얹었다.
   */
  const onRenameTag = useEventCallback((from: string, to: string) => {
    const next = to.trim().slice(0, 16);
    if (!next || next === from) return;
    const ids = items.filter((i) => i.tag === from).map((i) => i.id);
    if (!ids.length) return;
    tagMany(ids, next, "분류 이름을 바꿨습니다");
  });

  /**
   * 태그 삭제 — 그 태그를 단 모든 카드가 분류 없음이 된다 (D147).
   *
   * **카드는 지우지 않는다.** 지우는 것은 분류이고, 글은 학생의 것이다.
   * 이 카드 하나만 떼는 것(detach)은 '분류 없음' 고르기다.
   */
  const onRemoveTag = useEventCallback((tag: string) => {
    const ids = items.filter((i) => i.tag === tag).map((i) => i.id);
    if (!ids.length) return;
    tagMany(ids, null, `분류 '${tag}'을(를) 지웠습니다`);
  });

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

  /* ── 카드 수정 도구 (D180) — 끊고 붙이기 ─────────────────────────── */

  /**
   * 별 포인터로 누른 순간의 맥락.
   *
   * **여기서 한 번만 만든다.** 후보 목록과 자손 집합을 매 렌더에 계산하면
   * 아무도 안 끄는 동안에도 카드 수만큼 곱해진 일이 계속 돈다.
   */
  /* ── 카드 밀어내기 (D207) ─────────────────────────────────────────── */

  /**
   * 지금 캔버스에 있는 모든 카드의 자리.
   *
   * **끌 때마다 새로 읽는다.** 값으로 들고 있으면 카드가 하나 늘 때마다
   * 구독이 다시 걸리고, 드래그 도중에 그 일이 나면 밀림이 한 프레임 끊긴다.
   */
  const cardRects = useEventCallback(() => {
    const out = new Map<string, Rect>();
    for (const it of items) {
      const p = layout.positions.get(it.id);
      const sz = layout.sizes.get(it.id);
      if (!p || !sz) continue;
      out.set(it.id, { x: p.x, y: p.y, w: sz.w, h: sz.h });
    }
    return out;
  });

  const commitPush = useEventCallback(
    (moves: readonly { id: string; x: number; y: number }[]) => {
      // 밀려난 자리는 **학생이 정한 자리와 같은 자격**이다 — 배치 엔진이
      // 다시 밀어내면 방금 비켜 준 것이 헛일이 된다(moveMany가 pinned로 쓴다).
      store.moveMany(moves, "카드 비켜남");
    },
  );

  useCardPush({
    rectsOf: cardRects,
    commit: commitPush,
    gap: clientSettings.cardMinGap,
    strength: clientSettings.cardPushStrength,
    speedMs: clientSettings.cardPushSpeedMs,
  });

  const beginEdit = useEventCallback((id: string): EditContext | null => {
    const at = layout.positions.get(id);
    const size = layout.sizes.get(id);
    if (!at || !size) return null;

    const kids = descendants(items, id);
    // 자기 자신과 자기 가지에는 못 붙는다 — 붙이면 순환이다.
    const blocked = new Set<string>([id, ...kids]);

    /**
     * 붙을 수 있는 것은 **AI 개념 카드**뿐이다 (D151: 트리 노드의 조건).
     * 학생 메모·도판·클립에 붙이면 간선이 성립하지 않아 붙자마자 사라진다.
     */
    const candidates: Candidate[] = [];
    for (const it of items) {
      if (blocked.has(it.id)) continue;
      if (!isTreeNode(it)) continue;
      const p = layout.positions.get(it.id);
      const sz = layout.sizes.get(it.id);
      if (!p || !sz) continue;
      candidates.push({ id: it.id, rect: { x: p.x, y: p.y, w: sz.w, h: sz.h } });
    }

    return {
      parentId: treeEdges(items).find((e) => e.to === id)?.from ?? null,
      rect: { x: at.x, y: at.y, w: size.w, h: size.h },
      candidates,
      blocked,
      moving: [id, ...kids],
    };
  });

  /**
   * 손을 뗐다 — 좌표와 관계를 **한 항목으로** 저장한다.
   *
   * 나눠 저장하면 되돌리기가 둘로 갈려서, 한 번 되돌렸을 때 "자리는 돌아왔는데
   * 관계는 안 돌아온" 상태가 남는다. 학생 눈에는 고장이다.
   *
   * 붙일 때 **가지 전체의 분류를 부모 것으로 바꾼다.** 간선은 분류가 같을 때만
   * 성립하므로(D151), 자기만 바꾸면 자식들이 그 자리에서 흩어진다 — D156이
   * 분류 변경에서 이미 겪은 그것이다.
   */
  /**
   * 연결선의 X를 눌렀다 — 그 카드의 부모를 끊는다 (D210 4-4).
   *
   * 떼기 도구(카드 수정)는 그대로 둔다. 없애는 것이 아니라 **다른 길을 하나
   * 더** 여는 것이다 — 손으로 끌어 떼는 것이 불편하다는 의견이 있었지만,
   * 그 길을 쓰던 학생의 손버릇을 뺏을 이유는 없다.
   *
   * 자리는 건드리지 않는다. 끊긴 카드가 그 자리에 그대로 있어야 "관계만
   * 끊었다"로 읽힌다 — 튀어 나가면 무슨 일이 일어났는지 모른다.
   */
  const onCut = useEventCallback((childId: string) => {
    patch(childId, { parent_item_id: null, pinned: true });
  });

  /**
   * 포트에서 끌어 이었다 (D210 4-3).
   *
   * 저장 규칙은 카드 수정 도구와 **같다** — 자식 가지 전체가 새 부모의 분류를
   * 따라간다(6-3). 두 길이 다른 결과를 내면 학생이 어느 쪽을 썼는지에 따라
   * 캔버스가 달라진다.
   */
  const linkCards = useEventCallback((parentId: string, childId: string) => {
    slowMove();
    const parent = items.find((i) => i.id === parentId);
    const branch = [childId, ...descendants(items, childId)];
    const tag = parent?.tag ?? null;
    patchMany(
      branch.map((id) => ({
        id,
        patch: id === childId ? { parent_item_id: parentId, tag } : { tag },
      })),
      "카드를 이었습니다",
    );
  });

  /** 순환을 만들지 않는다 — 자기 자신이나 자기 자손을 부모로 삼을 수 없다. */
  const canLink = useEventCallback((parentId: string, childId: string) => {
    if (parentId === childId) return false;
    return !descendants(items, childId).includes(parentId);
  });

  const portLink = usePortLink({
    toWorld: (cx, cy) => {
      const root = document.querySelector(".canvas2");
      return bridge.toWorld(cx, cy, root?.getBoundingClientRect() ?? new DOMRect());
    },
    cardAt: (w) => {
      for (const [id, at] of layout.positions) {
        const sz = layout.sizes.get(id);
        if (!sz) continue;
        if (w.x >= at.x && w.x <= at.x + sz.w && w.y >= at.y && w.y <= at.y + sz.h) {
          return id;
        }
      }
      return null;
    },
    onLink: linkCards,
    canLink,
  });

  const onEditEnd = useEventCallback((r: EditResult) => {
    const kids = descendants(items, r.id);
    const branch = [r.id, ...kids];
    const entries: { id: string; patch: ItemPatch }[] = [];

    // 1) 자리 — 가지 전체가 같은 양만큼 움직였다.
    for (const mid of branch) {
      const p = layout.positions.get(mid);
      if (!p) continue;
      entries.push({
        id: mid,
        patch: { x: p.x + r.dx, y: p.y + r.dy, pinned: true },
      });
    }
    const patchOf = (id: string) => {
      const found = entries.find((e) => e.id === id);
      if (found) return found.patch;
      const made = { id, patch: {} as ItemPatch };
      entries.push(made);
      return made.patch;
    };

    let label = "가지를 옮겼습니다";
    // 이어 붙이거나 떼어내면 가지 전체의 분류가 바뀐다 = 열을 건넌다 (6-3).
    if (r.attachTo || r.detached) slowMove();
    if (r.attachTo) {
      const parent = items.find((i) => i.id === r.attachTo);
      const tag = parent?.tag ?? null;
      patchOf(r.id).parent_item_id = r.attachTo;
      // 가지 전체가 부모의 분류를 따라간다 — 안 그러면 자식들이 흩어진다.
      for (const mid of branch) patchOf(mid).tag = tag;
      label = "가지를 이어 붙였습니다";
    } else if (r.detached) {
      /**
       * 떼어낸 가지는 **분류가 없다**(사용자 결정 2026-08-05).
       *
       * 부모 연결만 끊으면 같은 분류 열에 새 뿌리로 남아 "떼어냈다"가 화면에
       * 안 드러난다. 분류를 비우면 자기 열로 빠지고, 그러고도 가지 안쪽
       * 연결은 살아 있다(D180: 분류 없는 가지도 트리다).
       */
      patchOf(r.id).parent_item_id = null;
      for (const mid of branch) patchOf(mid).tag = null;
      label = "가지를 떼어냈습니다";
    }

    /**
     * **관계가 바뀌었으면 언제나 `patchMany`다** — 가지가 한 장이어도.
     *
     * `patch`는 patch 내용에서 라벨을 유추하는데, 분류가 들어 있으면 "분류를
     * 바꿨습니다"가 된다. 학생이 한 일은 가지를 떼어낸 것이다 — 되돌리기
     * 버튼 옆의 그 한 줄이 무슨 일이 있었는지를 말하는 유일한 자리다
     * (실측 2026-08-06: 떼어냈는데 "분류를 바꿨습니다"가 떴다).
     */
    const moved = !r.attachTo && !r.detached;
    if (moved && entries.length === 1) {
      patch(entries[0].id, entries[0].patch);
      return;
    }
    /**
     * **"재배치" 배지를 달지 않는다** (D180).
     *
     * 학생이 방금 손으로 정한 자리다. 거기에 대고 "다시 배치할까요"를 묻는
     * 것은 어색하고, 가지가 크면 배지가 우수수 뜬다(사용자 2026-08-06:
     * "ui가 너무 많이 깨져").
     */
    patchMany(entries, label);
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
      onRenameTag,
      onRemoveTag,
      onDragEnd,
      onCut,
      onPortDrag: portLink.begin,
      onResize,
      onResetSize,
      onAsk,
      onPick,
    }),
    [onCut, portLink.begin, onSelect, onStartEdit, onCancelEdit, onCommitEdit, onDelete, onTagChange, onRenameTag, onRemoveTag, onDragEnd, onResize, onResetSize, onAsk, onPick],
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
   * 질문 방향성 코치 (D194) — 규칙·문구·자리 계산은 훅이 가진다.
   *
   * 발동 판정에 **브랜치(조상 사슬)**가 필요하고 부모를 정하는 곳이 여기라
   * (D151 `assignParents`) 호출은 여기서 한다 — 서버에도 같은 판정을 두면
   * 둘이 갈리는데 그 어긋남은 "가끔 안 뜬다"로만 보인다.
   */
  const coach = useQuestionCoach({
    items,
    positions: layout.positions,
    sizes: layout.sizes,
    pickedId,
    patch,
  });

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
    /**
     * **화면에 그려진 상자를 잰다** — 배치 맵이 아니라.
     *
     * 예전에는 `layout.positions`·`layout.sizes`로 상자를 만들었는데, 방금
     * 답이 끝난 카드의 크기가 아직 옛 값이라 상자가 작게 잡혔다. 그래서
     * **한 번 눌러서는 안 맞고 세 번 눌러야 맞았다**(실측 2026-08-07:
     * 배율 0.806 → 0.679 → 0.438, 필요한 값은 0.438). 학생 눈에는 "전체
     * 보기를 눌렀는데 카드가 아직 화면 밖"이다 — 그러면 그 버튼을 안 믿는다.
     *
     * 아이템은 월드 좌표로 절대 배치되고 `offsetWidth/Height`는 transform
     * 배율의 영향을 받지 않으므로, DOM 값이 그대로 월드 단위다.
     */
    const rects = items
      .map((i) => {
        const el = document.querySelector<HTMLElement>(
          `[data-canvas-item="${CSS.escape(i.id)}"]`,
        );
        if (el) {
          return {
            x: parseFloat(el.style.left) || 0,
            y: parseFloat(el.style.top) || 0,
            w: el.offsetWidth || ITEM_W,
            h: el.offsetHeight || FALLBACK_H,
          };
        }
        // 아직 안 그려진 것(첫 프레임)은 배치 맵으로 어림한다.
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
   * 교차 연결이 가리키는 과거 대화로 이동한다 (D176).
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
  /**
   * 질문 필기 (D176) — **기존 펜(자유선)으로 받는다**.
   *
   * 우리 캔버스를 얹어 직접 그리다가 갈아탔다(사용자 보고 2026-08-04: "다음
   * 획마다 끊긴다. 하지만 기존 펜은 자연스럽게 써진다"). 이미 자연스럽게
   * 써지는 것이 같은 화면에 있는데 흉내를 고치는 것은 순서가 틀렸다.
   * 우리가 하는 일은 그 획을 **글자로 바꾸는 것**뿐이다.
   *
   * `inkPhase`는 **파생값이다** — state로 들고 이펙트에서 맞추면 도구와 단계가
   * 어긋나는 순간이 생기고(렌더 한 번 사이), React Compiler도 막는다.
   */
  const askPen = bridge.activeTool === "askpen";
  const inkPhase: "writing" | "review" | null = !askPen
    ? null
    : inkRecognized
      ? "review"
      : "writing";

  /**
   * 캔버스에 남아 있는 질문 획 전부 — **표시로 고른다**(시점이 아니라).
   *
   * 도구를 잠깐 바꿨다 돌아와도 앞서 쓴 질문 획이 계속 잡힌다. 기준선으로
   * 가르던 때는 그것들이 미아가 됐다(인식도 안 되고 지워지지도 않았다).
   */
  const askStrokes = useCallback(
    () => allAskStrokes(bridge.api?.getSceneElements() ?? [], markBaseRef.current),
    [bridge.api],
  );

  /**
   * 방금 그은 획들에 **질문 표시를 찍는다** — 획이 끝난 뒤의 discrete한 순간에만.
   *
   * `updateScene({elements})`는 `replaceAllElements`라 **그리는 중에 부르면
   * 그리던 획이 끊긴다**(공식 문서가 드래그 중 사용을 금한다). 그래서 도구를
   * 바꿀 때와 인식할 때만 부른다.
   */
  const markPending = useCallback(() => {
    const els = bridge.api?.getSceneElements() ?? [];
    const fresh = pendingStrokes(els, markBaseRef.current);
    if (!fresh.length) return;
    const ids = new Set(fresh.map((e) => e.id));
    bridge.api?.updateScene({
      elements: els.map((e) => (ids.has(e.id) ? markAsk(e) : e)),
    });
  }, [bridge.api]);

  /**
   * 도구를 바꿀 때 필기 단계를 **함께** 되돌린다.
   *
   * 이벤트 핸들러라 이펙트가 필요 없다. 질문하는 펜을 켤 때 기준선을 새로 찍는다.
   *
   * **획 스타일은 건드리지 않는다** — 기존 펜이 쓰던 그대로 쓴다(사용자 지시
   * 2026-08-04: "기존 펜의 글씨 써지는 라이브러리만 사용"). 화면에 무슨 색으로
   * 그려지든 OCR과 무관하다: 보내는 그림은 **점에서 다시 그린다**(흰 종이에
   * 검은 획). 그래서 색·굵기를 우리가 정할 이유가 없다.
   */
  /**
   * 지도 화면으로 나간다 (D205).
   *
   * 나가기 전에 **지금 배치를 스토어에 남긴다.** 배치는 실측 크기에
   * 의존하는데(ResizeObserver) 지도 페이지에는 카드가 없다 — 거기서 다시
   * 계산하면 캔버스와 다른 자리에 점이 찍힌다.
   */
  /**
   * 지도를 **이 화면 위에** 띄운다 (D210 5-1).
   *
   * D205는 지도를 별도 페이지로 뺐다. 캔버스가 넓어진 것은 얻었지만 이동
   * 자체가 불편하다는 의견이 왔다 — 잠깐 보려고 화면을 통째로 바꾸는 것은
   * 값이 크다. 페이지는 남겨 둔다(주소로 들어오는 길). 같은 `SessionMap`을
   * 쓰므로 둘이 갈라지지 않는다.
   */
  const [mapOpen, setMapOpen] = useState(false);
  const openMap = useCallback(() => {
    // 페이지 쪽도 살아 있으므로 배치 사진은 계속 남긴다.
    if (sessionId) {
      setMapSnapshot({
        spaceId,
        sessionId,
        items,
        positions: [...layout.positions].map(([id, p]) => [id, { x: p.x, y: p.y }]),
        sizes: [...layout.sizes].map(([id, sz]) => [id, { w: sz.w, h: sz.h }]),
        tagOrder: [...layout.tagOrder],
      });
    }
    setMapOpen((v) => !v);
  }, [items, layout.positions, layout.sizes, layout.tagOrder, sessionId, setMapSnapshot, spaceId]);

  /** 지도에서 노드를 끌어 옮겼다 — 캔버스 좌표를 그대로 옮긴다. */
  const moveFromMap = useEventCallback((id: string, x: number, y: number) => {
    store.moveMany([{ id, x, y }], "지도에서 옮김");
  });

  /** 지도에서 노드를 눌렀다 — 그 카드로 날아간다. */
  const openFromMap = useEventCallback((id: string) => {
    setMapOpen(false);
    goToNode(id);
  });

  const handleTool = useCallback(
    (tool: ToolName) => {
      setInkRecognized(false);
      setInkCount(0);
      // 도구를 바꾸면 방금 읽은 표시도 버린다 — 그 표시는 지워진 획의 것이고,
      // 남겨 두면 **다음에 자판으로 친 질문에 엉뚱한 카드가 딸려 간다.**
      setInkContext(null);
      // 질문하는 펜을 떠나기 전에 방금 쓴 것을 표시해 둔다 — 그래야 다시
      // 돌아왔을 때 앞서 쓴 질문 획이 계속 질문 획이다.
      if (bridge.activeTool === "askpen" && tool !== "askpen") markPending();
      if (tool === "askpen") {
        markBaseRef.current = new Set(
          (bridge.api?.getSceneElements() ?? []).map((e) => e.id),
        );
      }
      bridge.setTool(tool);
    },
    [bridge, markPending],
  );

  /**
   * 그은 만큼 버튼이 켜지게 — 자유선은 우리 손을 안 거치므로 **씬을 본다**.
   *
   * **저장 신호(`onSceneCommit`)에 물리면 안 된다** — 거기엔 1.5초 디바운스가
   * 걸려 있어서, 쓰는 동안 타이머가 계속 밀리고 **손을 멈춘 뒤에야** 버튼이
   * 켜진다(사용자 보고 2026-08-05: "글씨를 쓰면 왜 버튼이 활성화되지 않지?").
   * 저장과 화면 반응은 리듬이 다르다.
   */
  const recountInk = useCallback(
    (elements: readonly ExcalidrawElementLike[]) => {
      if (bridge.activeTool !== "askpen") {
        // 다른 도구로 그린 획에는 표시를 찍지 않는다 — 그것이 구분의 전부다.
        return;
      }
      /**
       * **세기만 한다.** 여기서 씬을 되쓰면(표시를 찍으면) 그리던 획이 끊긴다 —
       * 이 신호는 획을 긋는 **도중에도** 오기 때문이다. 표시는 도구를 바꾸거나
       * 인식할 때 찍는다.
       */
      setInkCount(allAskStrokes(elements, markBaseRef.current).length);
    },
    [bridge.activeTool],
  );

  /**
   * 손글씨를 읽고, **표시가 무엇을 가리키는지도 함께 읽는다** (D178).
   *
   * D176은 획을 글자로만 바꿨다. 그런데 학생이 하는 일은 그것만이 아니다 —
   * 카드를 동그라미 치고, 화살표를 긋고, 그 끝에 질문을 쓴다. 글자만 보내면
   * **"이거"가 사라진다.**
   *
   * 그림 두 장이 나간다. OCR로는 **획만**(카드가 섞이면 카드 본문까지 읽어
   * 와 질문과 가르는 일이 새로 생긴다), 비전으로는 **획 + 카드**(가리킨
   * 대상이 그림에 없으면 무엇을 가리키는지 물을 수 없다).
   */
  const recognizeInk = useCallback(async () => {
    if (inkBusy) return;
    // 획이 끝난 뒤의 순간이다 — 여기서 표시를 찍어 둔다(그리는 중이 아니라).
    markPending();
    const els = askStrokes();
    if (!els.length) return;
    const strokes = toStrokes(els);
    const png = await renderInkPng(strokes, window.devicePixelRatio || 1);
    if (!png) return;
    setInkBusy(true);
    try {
      /**
       * 도식 만들기는 **질문을 막지 않는다**. 실패하면 표시 없이 글자만
       * 읽는다 — 카드가 근처에 없을 때와 같은 상태이고, 그건 정상이다.
       */
      let shot: InkCapture = EMPTY_CAPTURE;
      try {
        shot = await captureInk(
          strokes,
          {
            items,
            positions: layout.positions,
            sizes: layout.sizes,
            zoom: bridge.cameraRef.current.zoom,
          },
          {
            cardMax: clientSettings.inkCardMax,
            nearPad: clientSettings.inkNearPad,
            boxMaxScale: clientSettings.inkBoxMaxScale,
            sceneMaxSide: clientSettings.inkSceneMaxSide,
            figureZoomEnabled: clientSettings.inkFigureZoomEnabled,
          },
        );
      } catch (err) {
        // 조용히 넘기지 않는다 — 실패가 흔적을 안 남기면 기능이 꺼진 줄 모른다.
        console.warn("[ink] 도식을 만들지 못했다 — 표시 없이 보낸다", err);
      }
      /**
       * **자른 것은 자랐다고 말한다.** 상한(`ink_card_max`)에 걸려 버린 카드가
       * 있으면 남긴다 — 조용한 절단은 "다 봤다"로 읽히고, 나중에 "왜 저 카드는
       * 안 봤지"를 쫓을 실마리가 어디에도 없게 된다.
       */
      if (shot.dropped > 0) {
        console.warn(
          `[ink] 표시 주변 카드 ${shot.dropped}개를 상한(${clientSettings.inkCardMax})으로 버렸다`,
        );
      }

      const { text, marksNote } = await interpretInk({
        ink: png,
        scene: shot.scene,
        figure: shot.figure,
        figureN: shot.figureN,
        cards: shot.cards,
        gestures: shot.gestures,
      });
      const clean = text.trim();
      if (!clean) {
        setDrawError("글씨를 알아보지 못했어요. 조금 크게 다시 써 볼까요?");
        return;
      }
      // 글자가 됐으므로 획은 캔버스에서 사라진다(사용자 결정 2026-08-04).
      const gone = new Set(els.map((e) => e.id));
      const rest = withoutStrokes(bridge.api?.getSceneElements() ?? [], gone);
      bridge.api?.updateScene({ elements: rest });
      setInkCount(0);
      askBarRef.current?.appendText(clean);
      /**
       * 표시 해석은 **다음에 보낼 질문에 실린다.** 입력창에 붙이지 않는다 —
       * 저장되는 질문은 학생이 쓴 것 그대로여야 툴팁·기록이 맞는다.
       * 가리킨 번호는 설명 안에 `[카드 N]`으로 이미 들어 있다.
       */
      /**
       * **짚은 카드가 이 턴의 부모가 된다** (사용자 지시 2026-08-05).
       *
       * 학생이 특정 카드를 가리키며 물었으면 그 답은 그 카드에서 갈라져
       * 나와야 한다 — "이 카드에 대해 더" 라는 뜻이기 때문이다. 트리 부모가
       * 될 수 있는 것은 **AI 개념 카드**뿐이다(D151) — 도판·클립을 짚었으면
       * 부모 없이 간다(연결선이 성립하지 않는다).
       */
      const first = shot.pointed.length
        ? shot.cards.find((c) => c.n === shot.pointed[0])
        : undefined;
      const target = first ? items.find((i) => i.id === first.itemId) : undefined;
      const parentId =
        target && target.kind === "concept" && target.source === "ai"
          ? target.id
          : null;
      setInkContext(
        shot.cards.length
          ? {
              marksNote,
              cardIds: shot.cards.map((c) => c.itemId),
              pointed: shot.pointed,
              parentId,
            }
          : null,
      );
      setInkRecognized(true);
      setDrawError(null);
    } catch (err) {
      setDrawError(ocrErrorMessage(err));
    } finally {
      setInkBusy(false);
    }
  }, [
    askStrokes,
    bridge.api,
    bridge.cameraRef,
    clientSettings,
    inkBusy,
    items,
    layout.positions,
    layout.sizes,
    markPending,
  ]);

  /** 다시 쓰기 — 빈 화면에서 새로 (인식 때 이미 지워졌다). */
  const writeInkAgain = useCallback(() => {
    const gone = new Set(askStrokes().map((e) => e.id));
    if (gone.size) {
      const rest = withoutStrokes(bridge.api?.getSceneElements() ?? [], gone);
      bridge.api?.updateScene({ elements: rest });
    }
    setInkCount(0);
    setInkRecognized(false);
    setInkContext(null);
  }, [askStrokes, bridge.api]);

  const handleSend = useCallback(
    (question: string) => {
      const from = pickedId;
      const tag = pickedItem?.tag ?? null;
      /**
       * 표시는 **이 턴에만** 실린다 (D178). 비워 두지 않으면 다음 질문에도
       * 같은 카드가 딸려 가서, 학생이 이미 지운 화살표가 계속 답을 끌어당긴다.
       */
      const ink = inkContext;
      setInkContext(null);
      /**
       * **짚은 카드가 있으면 그 가지에서 이어 나간다** — 학생이 고른 노드보다
       * 우선한다. 손으로 그 카드를 가리키며 물은 것이 더 직접적인 의사표시다.
       */
      const parent = ink?.parentId ?? from;
      const parentTag = ink?.parentId
        ? (items.find((i) => i.id === ink.parentId)?.tag ?? tag)
        : tag;
      void stream.send(question, { pickedId: parent, ink }).then((created) => {
        /**
         * **학생이 기다리는 동안 고른 것을 덮어쓰지 않는다** (D187).
         *
         * 답이 오면 방금 받은 답 뒤로 초점을 옮기는 것이 기본이다. 그런데
         * 예전에는 그것을 **무조건** 했다 — 학생이 스트리밍 중에 다른 카드를
         * 눌러 두었어도 이 줄이 그 뜻을 지웠다. 게다가 아무것도 안 골랐던
         * 턴이면 `nextFocus(null, null, …)`가 null을 돌려주므로, 학생이 방금
         * 누른 카드의 인용 칩이 **답이 끝나는 순간 사라진다.**
         *
         * 실측 2026-08-06: 답이 뜨자마자 카드를 누르면 칩이 붙었다가 스트림이
         * 끝나면서 없어졌다. 학생 눈에는 "눌렀는데 표시가 사라진다"이고,
         * 그대로 질문을 보내면 답이 엉뚱한 자리(뿌리)에 붙는다.
         *
         * 보낼 때와 같으면 우리가 옮기고, 달라졌으면 **학생 쪽이 이긴다** —
         * 방금 한 조작이 우리가 예정해 둔 이동보다 늦고 더 직접적이다.
         */
        setPickedId((cur) => (cur === from ? nextFocus(parent, parentTag, created) : cur));
        void coach.run(created);
      });
    },
    // coach.run은 useEventCallback이라 신원이 고정이다 — 넣어도 묶음이 안 깨진다.
    [inkContext, items, pickedId, pickedItem, stream, coach],
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
  const sessionTitle = detail?.session?.title?.trim() || "제목 없는 대화";

  // 세션 컨텍스트 파일 첨부 (D83) — 업로드 후 칩 바가 상태를 보여 준다.
  const handleAttach = useCallback(
    (file: File) => {
      if (!sessionId) return;
      setUploadError(null);
      // D196: 보내기 전에 끊는다 — 50MB 넘는 파일을 다 올린 뒤 413을 받으면
      // 교실 와이파이에서는 몇 분을 기다린 끝에 오류만 보게 된다.
      const reason = checkUploadFile(file);
      if (reason) {
        setUploadError(reason);
        return;
      }
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
    const 처음 = focusCamera(
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
        {
          maxZoom: clientSettings.focusZoom || NEW_NODE_ZOOM,
          minZoom: ATTACH_MIN_ZOOM,
          pad: FOCUS_PAD,
        },
      );
    flyTo(처음);
    // 여기서부터 이 카드가 자라는 것을 지켜본다 (D210 2-2).
    growRef.current = { id: focusId, cam: 처음 };
    clearFocus();
  }, [
    focusId, layout.positions, layout.sizes, storeItems, vp, flyTo, clearFocus,
    clientSettings.focusZoom,
  ]);

  /**
   * **자란 카드가 화면을 넘기면 그때 물러난다** (D210 2-2, 사용자 지시).
   *
   * 처음에는 지금처럼 235%로 당긴다(위 이펙트). 그 뒤 스트리밍으로 글이
   * 자라 실제로 넘칠 때만 배율을 낮춘다 — "긴 답이 예상되니 미리 줄인다"와
   * 다르다. 앞의 것은 짧은 답까지 작게 만든다.
   *
   * 카드 높이는 이미 `layout.sizes`가 ResizeObserver로 재고 있다. 관찰자를
   * 하나 더 두지 않고 그 값이 바뀔 때만 판정한다 — 매 프레임 배율을 다시
   * 계산하면 카메라가 끊임없이 흔들린다.
   */
  useEffect(() => {
    const g = growRef.current;
    if (!g) return;
    const p = layout.positions.get(g.id);
    const size = layout.sizes.get(g.id);
    if (!p || !size) return;
    const next = backOffCamera(
      { x: p.x, y: p.y, w: size.w, h: size.h },
      g.cam,
      { w: vp.w, h: vp.h, left: UI_LEFT, right: UI_RIGHT, top: UI_TOP, bottom: UI_BOTTOM },
      { minZoom: GROW_MIN_ZOOM, headroom: GROW_HEADROOM, topPad: GROW_TOP_PAD },
    );
    if (!next) return;
    growRef.current = { id: g.id, cam: next };
    flyTo(next);
  }, [layout.positions, layout.sizes, vp, flyTo]);

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
      // 질문 필기는 자유선이라 우리 손을 안 거친다 — **저장 디바운스가 아니라**
      // 변경 신호에 물린다(D176). 저장에 물렸더니 손을 멈춘 뒤에야 버튼이 켜졌다.
      onSceneChange={recountInk}
      onCanvasClick={handleCreateNote}
      onBackgroundClick={handleBackgroundClick}
      onMarquee={handleMarquee}
      onShapeDrag={handleShapeDrag}
      // 펜으로 쓰는 중에는 도구 단축키도 재운다 (D176).
      penWriting={askPen}
      sessionId={sessionId}
      onToolSelect={handleTool}
      chrome={
        <>
          {/* 교차 연결로 과거 대화에 들어왔을 때만 뜬다 (D176).
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
          {/* 지도는 **자기 화면으로 나갔다** (D205). 여기 남은 것은 버튼뿐이고
              크기를 두 배로 키웠다(사용자 지시 2026-08-07) — 캔버스 위의 크롬
              중에 이것만 화면을 바꾸는 문이라 다른 아이콘과 같은 크기면
              찾기 어렵다. */}
          <MapDoor onOpen={openMap} />
          <MiniMapOverlay
            items={items}
            positions={layout.positions}
            sizes={layout.sizes}
            tagOrder={layout.tagOrder}
            open={mapOpen}
            onClose={() => setMapOpen(false)}
            onOpenNode={openFromMap}
            onMoveNode={moveFromMap}
          />
          <div
            className="ui absolute left-1/2 z-30 w-[min(680px,calc(100%-140px))] -translate-x-1/2"
            // 펜 입력판이 펴진 만큼 비킨다 (D176) — 안 비키면 판 위에 겹쳐 뜬다.
            style={{ bottom: 152 }}
          >
            <SessionFilesBar sessionId={sessionId} uploadError={uploadError} />
          </div>
          {/**
           * 질문 필기의 상태를 화면 밖으로 낸다 — e2e가 **몇 획인지** 잰다.
           * 픽셀로는 못 센다(획끼리 겹치고, 캔버스에는 학생이 그린 그림도 있다).
           */}
          <span
            data-testid="ask-ink"
            data-strokes={inkCount}
            data-phase={inkPhase ?? "off"}
            className="sr-only"
            aria-hidden="true"
          />
          {inkPhase === "writing" && inkCount === 0 && (
            <p
              data-testid="ask-ink-hint"
              className="ui pointer-events-none absolute left-1/2 top-20 z-30 -translate-x-1/2 rounded-full px-3 py-1.5 text-[13px]"
              style={{
                background: "var(--c-raised)",
                color: "var(--c-ink-soft)",
                border: "1px solid var(--c-rule)",
                boxShadow: "var(--c-shadow-sm)",
              }}
            >
              캔버스에 질문을 손으로 써 보세요
            </p>
          )}
          <AskBar
            ref={askBarRef}
            inkPhase={inkPhase}
            inkReady={inkCount > 0}
            inkBusy={inkBusy}
            onRecognize={recognizeInk}
            onWriteAgain={writeInkAgain}
            onAttach={handleAttach}
            busy={stream.busy}
            reply={stream.reply}
            quote={quote}
            coachHint={coach.hint}
            disabled={!sessionId}
            focusSignal={askFocus}
            onClearQuote={() => setPickedId(null)}
            onSend={handleSend}
          />
        </>
      }
    >
      {/**
        * 질문 방향 말풍선 (D194).
        *
        * ItemLayer **앞에** 두지만 z-index로 위에 온다 — 카드가 겹쳐 그려져도
        * (선택 카드 z 12) 말풍선이 밑에 깔리면 안 된다는 사용자 지시.
        */}
      {coach.card && coach.box && (
        <CoachBubble
          advice={coach.card.data.coach!.advice!}
          x={coach.box.x}
          y={coach.box.y}
          width={coach.box.w}
          onDismiss={() => coach.dismiss(coach.card!.id)}
        />
      )}

      <ItemLayer
        items={store.items}
        positions={layout.positions}
        sizes={layout.sizes}
        tagOrder={layout.tagOrder}
        tagOptions={store.tagOptions}
        groupSize={groupSize}
        cardEdit={bridge.activeTool === "cardedit"}
        beginEdit={beginEdit}
        onEditEnd={onEditEnd}
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
/**
 * 지도로 나가는 문 (D205).
 *
 * 미니맵이 있던 자리(오른쪽 위)를 그대로 쓴다 — 학생이 지도를 찾던 곳이다.
 * 크기는 두 배(36 → 72px)다. 캔버스 위의 다른 아이콘들은 **이 화면 안에서**
 * 무언가를 하지만 이것만 화면을 바꾼다. 같은 크기로 두면 그 차이가 안 보인다.
 */
function MapDoor({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      data-no-pan
      onClick={onOpen}
      aria-label="개념 지도 열기"
      title="개념 지도"
      className="ui absolute right-4 top-4 z-30 flex h-[72px] w-[72px] flex-col items-center
                 justify-center gap-1 rounded-2xl border-2 transition-colors"
      style={{
        background: "var(--c-raised)",
        borderColor: "var(--c-rule)",
        color: "var(--c-live)",
        boxShadow: "var(--c-shadow-md)",
      }}
    >
      <MapIcon size={26} />
      <span className="label text-[10px]" style={{ color: "var(--c-ink-soft)" }}>
        지도
      </span>
    </button>
  );
}

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
