"use client";

// 태그 클러스터 d3-force 레이아웃 훅. 카드=force 노드: 자기 태그 무게중심으로 응집 +
// forceManyBody(노드 많은 태그가 더 멀리 밀어냄) + forceCollide(무겹침). 좌표는 창발적,
// 결정론 시드(tagSeed)로 재수화 안정. 데이터 변화 시 재가열 → 틱마다 위치 갱신(부드러운 이동).

import { useEffect, useRef, useState } from "react";
import {
  forceSimulation,
  forceManyBody,
  forceCollide,
  type Simulation,
} from "d3-force";
import { tagSeed, tagCentroids as centroidsOf, CARD_W } from "./tagLayoutCore";

interface LNode {
  id: string;
  tag: string;
  h: number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
}

type Positions = Map<string, { x: number; y: number }>;
type Centroids = Map<string, { x: number; y: number; count: number }>;

const COHESION = 0.08;  // 태그 무게중심 응집 강도
const CHARGE = -1600;   // 카드 간 반발(음수) — 노드 많은 태그가 총합으로 더 밀어냄
const COLLIDE_GAP = 28; // 무겹침 여백

// 노드 배열 → 렌더용 좌표/무게중심 스냅샷(틱 핸들러·이펙트에서만 호출).
function snapshot(arr: LNode[]): { positions: Positions; tagCentroids: Centroids } {
  const positions: Positions = new Map();
  for (const n of arr) positions.set(n.id, { x: n.x, y: n.y });
  return { positions, tagCentroids: centroidsOf(arr) };
}

export function useTagLayout(items: Array<{ id: string; tag: string; h: number }>) {
  // 틱마다 갱신되는 렌더 스냅샷(ref는 렌더 중 읽지 않도록 상태로 승격).
  const [snap, setSnap] = useState<{ positions: Positions; tagCentroids: Centroids }>(() => ({
    positions: new Map(),
    tagCentroids: new Map(),
  }));
  const simRef = useRef<Simulation<LNode, undefined> | null>(null);
  const nodesRef = useRef<Map<string, LNode>>(new Map());
  // 태그 첫등장 순서(결정론 시드용) — 세션 동안 누적.
  const tagIndexRef = useRef<Map<string, number>>(new Map());
  const tagCountRef = useRef<Map<string, number>>(new Map());

  // 입력 items의 안정 키(순서·태그·개수 변화 감지)
  const sig = items.map((i) => `${i.id}:${i.tag}:${Math.round(i.h)}`).join("|");

  useEffect(() => {
    const nodes = nodesRef.current;
    const seen = new Set<string>();
    for (const it of items) {
      const tag = (it.tag || "").trim() || "기타";
      seen.add(it.id);
      let n = nodes.get(it.id);
      if (!n) {
        if (!tagIndexRef.current.has(tag)) tagIndexRef.current.set(tag, tagIndexRef.current.size);
        const cardIdx = tagCountRef.current.get(tag) ?? 0;
        tagCountRef.current.set(tag, cardIdx + 1);
        const seed = tagSeed(tagIndexRef.current.get(tag)!, cardIdx);
        n = { id: it.id, tag, h: it.h, x: seed.x, y: seed.y };
        nodes.set(it.id, n);
      } else {
        n.tag = tag;
        n.h = it.h;
      }
    }
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);

    const arr = [...nodes.values()];
    // 태그 응집: 매 틱 무게중심 재계산 후 그쪽으로 속도 가함(커스텀 force).
    const cohesion = (alpha: number) => {
      const cs = centroidsOf(arr);
      for (const n of arr) {
        const c = cs.get(n.tag);
        if (!c) continue;
        n.vx = (n.vx ?? 0) + (c.x - n.x) * COHESION * alpha;
        n.vy = (n.vy ?? 0) + (c.y - n.y) * COHESION * alpha;
      }
    };
    // 틱마다 현재 노드 좌표를 스냅샷 상태로 밀어 리렌더(ref 읽기는 여기서만).
    const onTick = () => setSnap(snapshot(arr));

    let sim = simRef.current;
    if (!sim) {
      sim = forceSimulation<LNode>(arr)
        .force("charge", forceManyBody<LNode>().strength(CHARGE))
        .force("collide", forceCollide<LNode>((n) => Math.hypot(CARD_W, n.h) / 2 + COLLIDE_GAP))
        .force("cohesion", cohesion)
        .alphaMin(0.02)
        .on("tick", onTick);
      simRef.current = sim;
    } else {
      sim.nodes(arr);
      sim.force("collide", forceCollide<LNode>((n) => Math.hypot(CARD_W, n.h) / 2 + COLLIDE_GAP));
      sim.force("cohesion", cohesion);
      sim.on("tick", onTick);
      sim.alpha(0.9).restart(); // 재가열 → 전체 재배치 애니메이션
    }
    // 시드/재조정 직후 초기 좌표를 한 번 반영(틱 이전에도 위치 노출).
    setSnap(snapshot(arr));
    return () => {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  useEffect(() => () => { simRef.current?.stop(); }, []);

  return { positions: snap.positions, tagCentroids: snap.tagCentroids };
}
