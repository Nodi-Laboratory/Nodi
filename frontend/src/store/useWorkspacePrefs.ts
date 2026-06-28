import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * 워크스페이스 개인 선호(D47) + 클라이언트 UX 상태(D37 dismiss · D40 collapse).
 * localStorage 영속(per-디바이스). 서버 영속은 후속(P6).
 *
 * - fileSuggestionEnabled: 자료 제안 받기 on/off(전역). off면 제안 호출 자체 안 함.
 * - navigatorEnabled/Count/GateK/Period: 네비게이터 자동생성 선호 → /chat/stream navigator override.
 * - dismissedSuggestionSessions: 세션 단위로 제안 카드 닫음(X). 그 세션에선 다시 안 뜸.
 * - collapsedNavParents: 사용자가 명시적으로 접은 부모 id.
 * - expandedNavParents: 사용자가 명시적으로 펼친 부모 id(재로드 기본 collapse 휴리스틱 무력화용).
 */
interface WorkspacePrefsState {
  fileSuggestionEnabled: boolean;
  navigatorEnabled: boolean;
  /** 추천 질문 개수(표시값). admin 기본을 덮으려면 navigatorCountCustomized=true여야 함(D47). */
  navigatorCount: number;
  /** 사용자가 개수 슬라이더를 직접 건드렸는지. false면 override에서 omit → admin 기본 적용. */
  navigatorCountCustomized: boolean;
  navigatorGateK?: number;
  navigatorPeriod?: number;
  dismissedSuggestionSessions: string[];
  collapsedNavParents: string[];
  expandedNavParents: string[];

  setFileSuggestionEnabled: (v: boolean) => void;
  setNavigatorEnabled: (v: boolean) => void;
  /** 개수 설정(직접 조작) → customized=true. */
  setNavigatorCount: (v: number) => void;
  /** 개수를 admin 기본으로 되돌림(customized=false). */
  resetNavigatorCount: () => void;
  setNavigatorGateK: (v: number | undefined) => void;
  setNavigatorPeriod: (v: number | undefined) => void;

  dismissSuggestion: (sessionId: string) => void;
  isSuggestionDismissed: (sessionId: string) => boolean;

  /** 부모의 네비게이터 자식을 접음(명시). */
  collapseNavParent: (parentId: string) => void;
  /** 접힘/펼침 토글. defaultCollapsed = 재로드 기본 collapse 휴리스틱 결과. */
  toggleNavParent: (parentId: string, defaultCollapsed: boolean) => void;
  /** 현재 effective collapsed 여부(명시 상태 + 기본 휴리스틱). */
  isNavParentCollapsed: (parentId: string, defaultCollapsed: boolean) => boolean;
}

export const useWorkspacePrefs = create<WorkspacePrefsState>()(
  persist(
    (set, get) => ({
      fileSuggestionEnabled: true,
      navigatorEnabled: true,
      navigatorCount: 3,
      navigatorCountCustomized: false,
      navigatorGateK: undefined,
      navigatorPeriod: undefined,
      dismissedSuggestionSessions: [],
      collapsedNavParents: [],
      expandedNavParents: [],

      setFileSuggestionEnabled: (v) => set({ fileSuggestionEnabled: v }),
      setNavigatorEnabled: (v) => set({ navigatorEnabled: v }),
      setNavigatorCount: (v) =>
        set({
          navigatorCount: Math.max(1, Math.min(5, Math.round(v))),
          navigatorCountCustomized: true,
        }),
      resetNavigatorCount: () => set({ navigatorCountCustomized: false }),
      setNavigatorGateK: (v) => set({ navigatorGateK: v }),
      setNavigatorPeriod: (v) => set({ navigatorPeriod: v }),

      dismissSuggestion: (sessionId) =>
        set((s) =>
          s.dismissedSuggestionSessions.includes(sessionId)
            ? s
            : {
                dismissedSuggestionSessions: [
                  ...s.dismissedSuggestionSessions,
                  sessionId,
                ],
              },
        ),
      isSuggestionDismissed: (sessionId) =>
        get().dismissedSuggestionSessions.includes(sessionId),

      collapseNavParent: (parentId) =>
        set((s) => ({
          collapsedNavParents: s.collapsedNavParents.includes(parentId)
            ? s.collapsedNavParents
            : [...s.collapsedNavParents, parentId],
          expandedNavParents: s.expandedNavParents.filter((id) => id !== parentId),
        })),

      toggleNavParent: (parentId, defaultCollapsed) => {
        const s = get();
        const collapsed = s.isNavParentCollapsed(parentId, defaultCollapsed);
        if (collapsed) {
          // 펼치기: 명시 펼침에 추가, 명시 접힘에서 제거
          set({
            expandedNavParents: s.expandedNavParents.includes(parentId)
              ? s.expandedNavParents
              : [...s.expandedNavParents, parentId],
            collapsedNavParents: s.collapsedNavParents.filter(
              (id) => id !== parentId,
            ),
          });
        } else {
          // 접기: 명시 접힘에 추가, 명시 펼침에서 제거
          set({
            collapsedNavParents: s.collapsedNavParents.includes(parentId)
              ? s.collapsedNavParents
              : [...s.collapsedNavParents, parentId],
            expandedNavParents: s.expandedNavParents.filter(
              (id) => id !== parentId,
            ),
          });
        }
      },

      isNavParentCollapsed: (parentId, defaultCollapsed) => {
        const s = get();
        if (s.collapsedNavParents.includes(parentId)) return true;
        if (s.expandedNavParents.includes(parentId)) return false;
        return defaultCollapsed;
      },
    }),
    {
      name: "nodi-workspace-prefs",
      partialize: (s) => ({
        fileSuggestionEnabled: s.fileSuggestionEnabled,
        navigatorEnabled: s.navigatorEnabled,
        navigatorCount: s.navigatorCount,
        navigatorCountCustomized: s.navigatorCountCustomized,
        navigatorGateK: s.navigatorGateK,
        navigatorPeriod: s.navigatorPeriod,
        dismissedSuggestionSessions: s.dismissedSuggestionSessions,
        collapsedNavParents: s.collapsedNavParents,
        expandedNavParents: s.expandedNavParents,
      }),
    },
  ),
);
