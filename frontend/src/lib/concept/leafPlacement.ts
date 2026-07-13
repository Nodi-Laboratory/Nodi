// 리프 노드(영상/삽화) 무겹침 배치 — 개념 카드/다른 리프와 절대 겹치지 않게
// 선호 위치에서 나선으로 확장하며 가장 가까운 빈 자리를 찾는다(결정론).
// 서버 canvas_layout._first_free_position(AABB 나선 탐색) 이식. 캔버스는
// 무한 팬이므로 경계 클램프는 없다.

import type { CanvasLeafNode, Concept } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 리프 실측 근사 크기(px). VideoNode .node=340폭, ArtNode=220폭. 충돌 회피는
// 과대추정이 안전(여백↑) — 실제 렌더보다 약간 크게 잡아 시각적 겹침을 배제한다.
export const LEAF_DIMS: Record<CanvasLeafNode["type"], { w: number; h: number }> = {
  video: { w: 340, h: 132 },
  art: { w: 220, h: 210 },
};

// 개념 카드 폭/높이 — ConceptCard.cardHeight와 상수 일치(160/560/28).
const CARD_W = 420;
const CARD_H_MIN = 160;
const CARD_H_MAX = 560;
const CARD_H_PER_LINE = 28;
const CARD_H_STREAM_LINES = 2; // pending/스트리밍 기본(estimate_card_height(2))

// 카드 렌더 높이 근사: 서버 저장 concept.h 우선, 없으면 본문 "p" 블록 수(=줄 수)
// 기반 폴백. ConceptCard와 동일 로직 → 장애물 높이가 실제 렌더 높이와 일치.
function cardHeight(c: Concept): number {
  if (typeof c.h === "number" && c.h > 0) return c.h;
  const lines = c.pending
    ? CARD_H_STREAM_LINES
    : (c.blocks ?? []).filter((b) => b.type === "p").length;
  return Math.max(CARD_H_MIN, Math.min(CARD_H_MAX, CARD_H_MIN + lines * CARD_H_PER_LINE));
}

export function cardRect(c: Concept): Rect {
  return { x: c.x, y: c.y, w: CARD_W, h: cardHeight(c) };
}

export function leafRect(n: Pick<CanvasLeafNode, "x" | "y" | "type">): Rect {
  const d = LEAF_DIMS[n.type];
  return { x: n.x, y: n.y, w: d.w, h: d.h };
}

// 카드/리프 사이 최소 간격(px) — 서버 force_min_gap과 동일.
const LEAF_GAP = 24;

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
  const step = 120; // 탐색 간격(px) — 좁은 틈도 포착
  for (let ring = 1; ring <= 80; ring++) {
    const r = ring * step;
    const samples = ring * 8; // 링마다 샘플 수↑ → 각 간격 일정 유지
    for (let k = 0; k < samples; k++) {
      const ang = (2 * Math.PI * k) / samples;
      const x = px + r * Math.cos(ang);
      const y = py + r * Math.sin(ang);
      if (free(x, y)) return { x, y };
    }
  }
  return { x: px, y: py };
}
