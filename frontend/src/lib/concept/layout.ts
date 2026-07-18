// FNV-1a 문자열 해시(결정론) + 카드 치수 상수.
//
// 과거 이 파일이 담던 그리드 기반 카드 배치(placeConcepts/anchorFor/nearestFreeCell
// 등)는 프론트 d3-force 태그 레이아웃(useTagLayout)으로 대체되어 제거됨. 남은 것은
// 여러 곳에서 재사용하는 해시와 카드 폭/여백 상수뿐이다.

const CARD_W = 420;
const MARGIN = 40;

// FNV-1a string hash (deterministic). 미세 회전 시드 등에 재사용.
export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export const LAYOUT = { CARD_W, MARGIN };
