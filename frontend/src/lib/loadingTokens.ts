// 08 D68/§4: "지연 상태 시각 언어"를 단일 토큰으로 승격.
// 코드 산재(SessionGraphCanvas.tsx:649·899·904·906 등)를 한 곳으로 모아
// pending(낙관·미확정) / loading(데이터 미도착) / 확정 전환의 값을 일관되게 쓴다.
// 원형 노드·위→아래 트리·라벨 아래 + accent(#fcf58b) 디자인 불변(메모리 nodi-graph-design).

/** pending(낙관) 노드 그룹 투명도. */
export const PENDING_NODE_OPACITY = 0.4;
/** pending(낙관) 링크 stroke 투명도. */
export const PENDING_LINK_OPACITY = 0.45;
/** pending 노드 외곽선 점선(낙관·네비게이터 공통). */
export const PENDING_NODE_DASH = "3 3";
/** pending 링크 점선. */
export const PENDING_LINK_DASH = "3 4";
/** 확정(실선) 링크 점선 패턴. */
export const SOLID_LINK_DASH = "4 3";
/** pending → 실체화 확정 전환 시간(ms). */
export const SETTLE_TRANSITION_MS = 300;
