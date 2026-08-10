/**
 * 개념 지도의 순수 계산 (D189) — 시작 자리 · 무리 이름 · 색.
 *
 * 그리기(캔버스)와 힘 배치(d3)는 컴포넌트에 있고, **혼자 검사할 수 있는 것**만
 * 여기 둔다. 지도가 틀렸는지는 눈으로 잘 안 보인다 — 그럴싸한 점 구름은 언제나
 * 그럴싸해 보인다.
 */

import type { ConceptEdge, ConceptNode } from "@/lib/api/conceptMap";

/** 힘 배치가 채워 넣는 좌표까지 포함한 노드. */
export interface PlacedNode extends ConceptNode {
  x: number;
  y: number;
  /** 이 노드에 걸린 선의 수. 굵기·크기가 여기서 나온다. */
  degree: number;
}

/**
 * 문자열 → 0..1 실수. 같은 입력은 언제나 같은 값이다.
 *
 * FNV-1a. 암호용이 아니라 **재현성**용이다 — 색과 시작 자리가 새로고침마다
 * 바뀌면 학생이 어제 본 지도를 못 알아본다.
 */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0으로 부호를 떼고 2^32로 나눈다.
  return (h >>> 0) / 4294967296;
}

/**
 * 시작 자리를 **id에서** 정한다.
 *
 * d3-force는 좌표가 없으면 스스로 원형으로 뿌리는데, 그 순서는 배열 순서라
 * 카드 하나가 늘면 **지도 전체가 다시 배치된다.** 학생 눈에는 "어제 왼쪽 위에
 * 있던 무리가 오늘은 오른쪽에 있다"이고, 그러면 지도가 아니라 매번 새 그림이다.
 *
 * 황금각으로 원판에 고르게 뿌린다 — 뭉치지 않아야 힘 배치가 제자리를 찾는다.
 * 두 점이 정확히 겹치면 d3가 난수로 흔들어 떼는데(jiggle), 그 순간 재현성이
 * 깨진다. 겹칠 확률을 낮추는 것이 여기서 하는 일이다.
 */
export function seedPositions(nodes: readonly ConceptNode[], radius: number) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return nodes.map((n, i) => {
    // 반지름은 id로, 각도는 색인으로 — 둘 다 쓰면 같은 id가 같은 자리에
    // 오면서도 전체가 고르게 퍼진다.
    const r = radius * Math.sqrt((i + 0.5) / Math.max(1, nodes.length));
    const a = i * golden + hash01(n.id) * 0.4;
    return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, degree: 0 };
  });
}

/** 노드별 선 개수. 없는 노드도 0으로 채운다(호출부가 `??`를 안 쓰게). */
export function degrees(
  nodes: readonly ConceptNode[],
  edges: readonly ConceptEdge[],
): Map<string, number> {
  const out = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (out.has(e.a)) out.set(e.a, out.get(e.a)! + 1);
    if (out.has(e.b)) out.set(e.b, out.get(e.b)! + 1);
  }
  return out;
}

export interface ClusterLabel {
  tag: string;
  x: number;
  y: number;
  count: number;
}

/**
 * 축소했을 때 보여 줄 **무리 이름**.
 *
 * 무리를 그래프에서 찾아내지(연결 성분·커뮤니티 검출) 않는다 — 선이 촘촘하면
 * 전부 한 덩어리가 되고, 무엇보다 **이름을 못 붙인다.** 학생에게 "무리 3"은
 * 아무 뜻도 없다. 분류 태그는 이미 사람이 읽는 이름이고(D123이 열로 쓰는 그것),
 * 자리는 의미로 뭉친 결과를 그대로 쓰므로 둘을 겹치면 "이름 있는 무리"가 된다.
 *
 * 태그가 없는 카드는 이름이 없다 — 점으로만 남는다.
 */
export function clusterLabels(
  placed: readonly PlacedNode[],
  minCount = 2,
): ClusterLabel[] {
  const acc = new Map<string, { x: number; y: number; count: number }>();
  for (const n of placed) {
    const tag = (n.tag || "").trim();
    if (!tag) continue;
    const cur = acc.get(tag) ?? { x: 0, y: 0, count: 0 };
    cur.x += n.x;
    cur.y += n.y;
    cur.count += 1;
    acc.set(tag, cur);
  }
  return [...acc]
    .filter(([, v]) => v.count >= minCount)
    .map(([tag, v]) => ({
      tag,
      x: v.x / v.count,
      y: v.y / v.count,
      count: v.count,
    }))
    // 큰 무리부터 — 겹칠 때 큰 이름이 위에 오게 한다.
    .sort((a, b) => b.count - a.count);
}

/**
 * 태그 → 색상(HSL 각도).
 *
 * 팔레트를 고정 배열로 두면 태그가 늘 때 **색이 돌려쓰기**되어 서로 다른 과목이
 * 같은 색을 갖는다. 이름에서 뽑으면 태그가 몇 개든 안정적이고, 같은 태그는
 * 언제나 같은 색이다.
 */
export function tagHue(tag: string | null): number {
  if (!tag) return 0;
  return Math.round(hash01(tag) * 360);
}

/**
 * 확대 배율에 따라 무엇을 보여 줄지 (D151 지도와 같은 태도).
 *
 * 멀리서 보면 이름, 가까이 가면 낱개. 둘을 동시에 그리면 축소했을 때 점 수천
 * 개가 서로를 지워 **아무것도 안 보이는 회색 판**이 된다.
 */
export type MapTier = "clusters" | "nodes" | "titles";

/** 글자가 차지하는 **화면** 사각형. 가운데 기준이다. */
export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 겹치지 않을 만큼만 이름을 고른다.
 *
 * 전부 그리면 글자가 서로를 덮어 **한 글자도 못 읽는다**(실측 2026-08-06:
 * 확대 화면이 검은 글자 벽이 됐고, 축소 화면에서는 무리 이름 넷이 한 점에
 * 쌓였다).
 *
 * ## 격자가 아니라 사각형으로 잰다
 *
 * 처음에는 화면을 격자로 나눠 칸마다 하나만 남겼는데, **넓은 글자는 못 막는다** —
 * "빛의 굴절과 분산"은 칸 하나보다 훨씬 넓어서 옆 칸의 이름과 겹쳤다(실측).
 * 글자 폭을 재서 실제 사각형끼리 부딪히는지 보는 것이 맞다.
 *
 * 입력 순서가 곧 **우선순위**다 — 앞에 있는 것이 자리를 잡는다. 호출부가
 * "무엇이 살아남아야 하는지"를 정렬로 표현하면 된다(큰 무리 · 선이 많은 개념).
 *
 * 좌표·크기는 **화면 px**이어야 한다. 월드 값으로 주면 배율마다 다른 개수가
 * 남는다.
 */
export function pickSpacedLabels<T>(
  items: readonly T[],
  boxOf: (item: T) => LabelBox,
  gap = 4,
): T[] {
  const placed: LabelBox[] = [];
  const out: T[] = [];
  for (const it of items) {
    const b = boxOf(it);
    const hit = placed.some(
      (p) =>
        Math.abs(p.x - b.x) * 2 < p.w + b.w + gap * 2 &&
        Math.abs(p.y - b.y) * 2 < p.h + b.h + gap * 2,
    );
    if (hit) continue;
    placed.push(b);
    out.push(it);
  }
  return out;
}

/**
 * 노드 전부를 담는 사각형. "전체 보기"의 재료다.
 *
 * 처음 배율을 상수로 두면 카드 수에 따라 **지도가 화면 가운데 점처럼 작거나
 * 화면 밖으로 넘친다**(실측: 개념 76개에서 1,200개용 배율을 쓰니 한가운데
 * 작은 얼룩이었다). 지도는 펼쳐진 채로 시작해야 지도다.
 */
export function boundsOf(
  placed: readonly { x: number; y: number }[],
): { x: number; y: number; w: number; h: number } | null {
  if (!placed.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

export function tierFor(zoom: number): MapTier {
  if (zoom < 0.55) return "clusters";
  if (zoom < 1.6) return "nodes";
  return "titles";
}
