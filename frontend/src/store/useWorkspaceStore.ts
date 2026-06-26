import { create } from "zustand";

/**
 * 워크스페이스 클라이언트 상태 (영구 데이터는 백엔드/Supabase가 정본).
 * - activeSessionId: 선택된 세션
 * - activeNodeId: 포커스 노드. 대화 스레드는 이 노드의 조상체인으로 펼쳐지고,
 *   다음 질문은 이 노드를 parent_node_id로 분기한다(사용자 주도 분기).
 */
interface WorkspaceState {
  activeSessionId: string | null;
  activeNodeId: string | null;
  setActiveSession: (id: string | null) => void;
  setActiveNode: (id: string | null) => void;
  reset: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeSessionId: null,
  activeNodeId: null,
  setActiveSession: (id) => set({ activeSessionId: id, activeNodeId: null }),
  setActiveNode: (id) => set({ activeNodeId: id }),
  reset: () => set({ activeSessionId: null, activeNodeId: null }),
}));
