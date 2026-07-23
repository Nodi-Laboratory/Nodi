// 리프 노드(교과서 figure) 무겹침 배치 — 개념 카드/다른 리프와 절대 겹치지 않게
// 선호 위치에서 나선으로 확장하며 가장 가까운 빈 자리를 찾는다(결정론).
// 서버 canvas_layout._first_free_position(AABB 나선 탐색) 이식. 캔버스는
// 무한 팬이므로 경계 클램프는 없다.

import { cardHeight } from "./cardMetrics";
import type { CanvasLeafNode, Concept } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 리프 실측 근사 크기(px). 충돌 회피는 과대추정이 안전(여백↑) — 실제 렌더보다
// 약간 크게 잡아 시각적 겹침을 배제한다. (D94: video/art 리프 제거)
export const LEAF_DIMS: Record<CanvasLeafNode["type"], { w: number; h: number }> = {
  // D87: FigureNode 이미지+캡션 근사(260폭).
  figure: { w: 260, h: 240 },
};

// 개념 카드 폭 — 높이는 cardMetrics(SSOT)의 cardHeight()에서 가져와 ConceptCard와 일치.
const CARD_W = 420;

export function cardRect(c: Concept): Rect {
  const hasSources = !!c.sources && c.sources.length > 0;
  return { x: c.x, y: c.y, w: CARD_W, h: cardHeight(c, hasSources) };
}

export function leafRect(n: Pick<CanvasLeafNode, "x" | "y" | "type">): Rect {
  const d = LEAF_DIMS[n.type];
  return { x: n.x, y: n.y, w: d.w, h: d.h };
}

// 카드/리프 사이 최소 간격(px) — 서버 force_min_gap과 동일.
const LEAF_GAP = 24;

// 나선 탐색 파라미터 — 선호 위치에서 밖으로 링을 넓혀가며 빈 자리를 찾는다.
const SPIRAL_STEP = 120; // 링 간 반경 증가(px) — 좁은 틈도 포착
const SPIRAL_RINGS = 80; // 최대 링 수(사실상 캔버스 전역 커버)
const SPIRAL_SAMPLES_PER_RING = 8; // ring마다 samples = ring * 이 값 → 각 간격 일정

// gap 포함 AABB 교차 판정.
function hit(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

// 선호 위치 (px,py)에서 나선으로 확장하며 어떤 장애물과도 안 겹치는 가장 가까운
// 좌표를 반환(결정론). 못 찾으면 선호 위치 반환(사실상 도달 불가 — 80링 커버).
export function placeLeafClear(
  px: number,
  py: number,
  w: number,
  h: number,
  obstacles: Rect[],
  gap: number = LEAF_GAP,
): { x: number; y: number } {
  const free = (x: number, y: number) =>
    obstacles.every((o) => !hit({ x, y, w, h }, o, gap));
  if (free(px, py)) return { x: px, y: py };
  for (let ring = 1; ring <= SPIRAL_RINGS; ring++) {
    const r = ring * SPIRAL_STEP;
    const samples = ring * SPIRAL_SAMPLES_PER_RING; // 링마다 샘플 수↑ → 각 간격 일정 유지
    for (let k = 0; k < samples; k++) {
      const ang = (2 * Math.PI * k) / samples;
      const x = px + r * Math.cos(ang);
      const y = py + r * Math.sin(ang);
      if (free(x, y)) return { x, y };
    }
  }
  return { x: px, y: py };
}
