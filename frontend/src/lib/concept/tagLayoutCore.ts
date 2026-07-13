// 태그 클러스터 레이아웃 순수 헬퍼 — 결정론 시드·무게중심·반경. d3/DOM 독립.
export const CANVAS_W = 3200;
export const CANVAS_H = 2200;
export const CARD_W = 420;
export const CENTER = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
export const TAG_GOLDEN = (Math.PI * (3 - Math.sqrt(5))); // ≈2.399 rad (황금각)

const TAG_R0 = 700; // 태그 시드 나선 반경 계수
const CARD_STEP = 60; // 태그 내 카드 미소 오프셋

// 태그 첫등장 순서 tagIndex(0-based) + 태그 내 카드 순번 cardIndex → 결정론 초기 위치.
// d3의 난수 초기화를 피하려 항상 x/y를 시드한다(재수화 안정).
export function tagSeed(tagIndex: number, cardIndex: number): { x: number; y: number } {
  const r = TAG_R0 * Math.sqrt(Math.max(0, tagIndex));
  const ang = tagIndex * TAG_GOLDEN;
  const bx = CENTER.x + r * Math.cos(ang);
  const by = CENTER.y + r * Math.sin(ang);
  // 카드 순번은 작은 나선으로 흩어 초기 겹침(=jiggle 난수) 방지
  const cr = CARD_STEP * Math.sqrt(cardIndex + 1);
  const cang = (cardIndex + 1) * TAG_GOLDEN;
  return { x: bx + cr * Math.cos(cang), y: by + cr * Math.sin(cang) };
}

// 태그별 노드 좌표 평균(무게중심) + count.
export function tagCentroids(
  nodes: Array<{ tag: string; x: number; y: number }>,
): Map<string, { x: number; y: number; count: number }> {
  const acc = new Map<string, { sx: number; sy: number; n: number }>();
  for (const nd of nodes) {
    const a = acc.get(nd.tag) ?? { sx: 0, sy: 0, n: 0 };
    a.sx += nd.x; a.sy += nd.y; a.n += 1;
    acc.set(nd.tag, a);
  }
  const out = new Map<string, { x: number; y: number; count: number }>();
  for (const [tag, a] of acc) out.set(tag, { x: a.sx / a.n, y: a.sy / a.n, count: a.n });
  return out;
}

// 클러스터 반경(count↑→반경↑) — 미니맵 점 크기·시드 참고용.
export function clusterRadius(count: number): number {
  return 40 + Math.sqrt(Math.max(1, count)) * 30;
}
