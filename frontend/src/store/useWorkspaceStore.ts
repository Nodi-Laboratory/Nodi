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
  // pendingSession은 의도적으로 유지(홈에서 설정 후 워크스페이스 마운트 시 소비)
  reset: () =>
    set({ activeSessionId: null, activeSessionSpaceId: null, activeNodeId: null }),
}));
