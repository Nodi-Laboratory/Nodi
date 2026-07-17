// 캔버스 카드 클러스터 앵커(D90). 고정 7태그 칠각형 → 모델 자유 태그의 동적 슬롯.
// EXAONE이 자유롭게 붙인 분류 태그를 "첫 등장 순서"로 황금각 슬롯에 영구 배치한다
// (슬롯↔좌표 매핑은 useTagLayout의 레지스트리가 관리). 파일명은 임포트 4곳 churn
// 회피를 위해 유지 — 더 이상 교육과정 고정 태그가 아니라 동적 슬롯 앵커 모듈이다.

export const CANVAS_W = 3200;
export const CANVAS_H = 2200;
export const CARD_W = 420;
export const CENTER = { x: CANVAS_W / 2, y: CANVAS_H / 2 };

export const TAG_RING_RADIUS = 1400; // 기존 칠각형 반경 유지 — 클러스터 간 분리
export const TAG_GOLDEN_ANGLE = 2.399963; // 황금각(rad) — 인접 슬롯 인덱스가 서로 멀리 떨어짐

// 슬롯 i(첫 등장 순서, 0-base)의 고정 앵커. 반경 고정 + 황금각 회전 —
// 슬롯이 늘어나도 기존 슬롯 위치가 절대 움직이지 않는다(D90 재배치 없음).
export function slotAnchor(i: number): { x: number; y: number } {
  const th = -Math.PI / 2 + i * TAG_GOLDEN_ANGLE;
  return { x: CENTER.x + TAG_RING_RADIUS * Math.cos(th), y: CENTER.y + TAG_RING_RADIUS * Math.sin(th) };
}
