import { create } from "zustand";

/**
 * 워크스페이스 클라이언트 상태 (영구 데이터는 백엔드/Supabase가 정본).
 * - activeSessionId: 선택된 세션
 * - activeNodeId: 포커스 노드. 대화 스레드는 이 노드의 조상체인으로 펼쳐지고,
 *   다음 질문은 이 노드를 parent_node_id로 분기한다(사용자 주도 분기).
 */
/**
 * 홈 → 워크스페이스로 넘기는 보류 작업.
 * spaceId 공간의 sessionId를 선택하고, seed가 있으면 첫 질문으로 전송한다.
 * (홈의 질문박스/총괄AI 액션이 새 세션을 만들어 시드 질문을 시작하는 경로.)
 */
export interface PendingSession {
  spaceId: string;
  sessionId: string;
  seed?: string;
}

interface WorkspaceState {
  activeSessionId: string | null;
  /**
   * `activeSessionId`가 **어느 공간의 세션인가** (D148).
   *
   * 세션은 공간에 속한다. 이걸 안 들고 있으면 개인 공간에 있다가 학급으로
   * 옮겼을 때 "세션이 이미 잡혀 있다"는 이유로 개인 세션의 대화가 학급
   * 화면에 그대로 뜬다(사용자 실측 2026-08-02) — 남의 공간에서 남의 글을
   * 편집하고 질문까지 보낼 수 있다.
   */
  activeSessionSpaceId: string | null;
  activeNodeId: string | null;
  /** 마지막으로 진입한 공간(spaceId). 개념 노드 페이지가 어느 공간을 보일지 결정. */
  activeSpaceId: string;
  pendingSession: PendingSession | null;
  /** 공간을 명시하지 않으면 지금 보고 있는 공간(activeSpaceId)의 세션으로 본다. */
  setActiveSession: (id: string | null, spaceId?: string) => void;
  setActiveNode: (id: string | null) => void;
  setActiveSpace: (spaceId: string) => void;
  setPendingSession: (p: PendingSession | null) => void;

  /**
   * 세션을 옮긴 **뒤에** 초점을 맞출 카드 (D171 교차 연결 이동).
   *
   * 이동 시점에는 목적지 세션이 아직 안 채워져 있다 — 수화는 세션당 한 번이고
   * 비동기다(D147). 그래서 "가서 이 카드를 보여 달라"는 요청을 여기 남기고,
   * 캔버스가 그 카드를 실제로 갖게 됐을 때 소비한다.
   */
  pendingFocusItemId: string | null;
  setPendingFocusItem: (id: string | null) => void;

  /**
   * 교차 연결로 과거 대화에 들어왔을 때 **돌아올 자리**.
   *
   * 어제 세션에 던져 놓고 끝내면 학생은 길을 잃는다. 원래 보던 곳을 기억해
   * 두고 한 번에 돌아갈 수 있게 한다.
   */
  returnTo: { sessionId: string; spaceId: string; itemId: string | null } | null;
  setReturnTo: (r: WorkspaceState["returnTo"]) => void;

  /**
   * 지도 화면이 그릴 **배치 사진** (D205).
   *
   * 지도를 별도 페이지로 떼면서 생긴 문제 하나: 배치(`useItemLayout`)는
   * **실측 크기**에 의존한다. 카드가 화면에 그려져 ResizeObserver가 재야
   * 높이·폭을 알고, 그 값이 열 안의 y 누적을 정한다. 지도 페이지에는 카드가
   * 없으므로 거기서 다시 계산하면 **캔버스와 다른 지도**가 나온다 — 지도가
   * 거짓말을 하는 셈이다.
   *
   * 그래서 캔버스가 계산한 결과를 그대로 넘긴다. 지도는 그리기만 한다.
   * Map은 담지 않는다(불변 취급이 어렵다) — 배열로 넘기고 지도가 되만든다.
   */
  mapSnapshot: {
    spaceId: string;
    sessionId: string;
    items: unknown[];
    positions: [string, { x: number; y: number }][];
    sizes: [string, { w: number; h: number }][];
    tagOrder: string[];
  } | null;
  setMapSnapshot: (s: WorkspaceState["mapSnapshot"]) => void;

  reset: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeSessionId: null,
  activeSessionSpaceId: null,
  activeNodeId: null,
  activeSpaceId: "personal",
  pendingSession: null,
  setActiveSession: (id, spaceId) =>
    set((s) => ({
      activeSessionId: id,
      activeSessionSpaceId: id ? (spaceId ?? s.activeSpaceId) : null,
      activeNodeId: null,
    })),
  setActiveNode: (id) => set({ activeNodeId: id }),
  setActiveSpace: (spaceId) => set({ activeSpaceId: spaceId }),
  setPendingSession: (p) => set({ pendingSession: p }),
  pendingFocusItemId: null,
  setPendingFocusItem: (id) => set({ pendingFocusItemId: id }),
  returnTo: null,
  setReturnTo: (r) => set({ returnTo: r }),
  mapSnapshot: null,
  setMapSnapshot: (m) => set({ mapSnapshot: m }),
  // pendingSession은 의도적으로 유지(홈에서 설정 후 워크스페이스 마운트 시 소비)
  reset: () =>
    set({
      activeSessionId: null,
      activeSessionSpaceId: null,
      activeNodeId: null,
      pendingFocusItemId: null,
      returnTo: null,
    }),
}));
