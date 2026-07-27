"use client";

// 태그 클러스터 d3-force 레이아웃 훅. 카드=force 노드: 자기 태그 앵커로 응집 +
// forceManyBody(클러스터 내 균등 분산) + forceCollide(무겹침). 태그 앵커는 동적 슬롯
// (D90): 모델 자유 태그를 첫 등장 순서로 황금각 슬롯에 영구 부여하므로 한번 정해진
// 태그 위치는 고정 → 결정론 시드로 재수화 안정. 데이터 변화 시 재가열 → 틱마다 위치 갱신(부드러운 이동).

import { useEffect, useRef, useState } from "react";
import {
  forceSimulation,
  forceManyBody,
  forceCollide,
  type Simulation,
} from "d3-force";
import { CARD_W, CENTER, slotAnchor } from "./curriculumTags";

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

const COHESION = 0.08;  // 태그 고정 앵커 응집 강도
const CHARGE = -500;    // 클러스터 내 균등 분산(인터-태그 분리는 고정 앵커)
const COLLIDE_GAP = 28; // 무겹침 여백
// 다 식은 sim에 크기 변화가 들어왔을 때만 주는 약한 nudge(재가열 0.9와 구분).
const RESIZE_NUDGE = 0.15;

// 카드 충돌 반경 — 높이가 바뀌면 이 힘만 다시 만들어 주면 된다.
function collideRadius(n: LNode): number {
  return Math.hypot(CARD_W, n.h) / 2 + COLLIDE_GAP;
}

// 결정론 시드용 소나선(피보나치 나선) — 새 카드를 자기 태그 앵커 근처의 겹치지 않는
// 자리에 뿌려 초기 겹침 방지 + 즉시 제자리(sim 재가열 전에도 위치 노출).
const SEED_RADIUS_STEP = 60;    // 반경 = STEP * sqrt(cardIdx+1)
const SEED_GOLDEN_ANGLE = 2.399963; // 황금각(rad) — 각 카드 간 각 분산

// 자기 태그 고정 앵커 근처의 결정론 시드 좌표를 계산한다(소나선).
function seedNear(
  anchor: { x: number; y: number },
  cardIdx: number,
): { x: number; y: number } {
  const radius = SEED_RADIUS_STEP * Math.sqrt(cardIdx + 1);
  const angle = (cardIdx + 1) * SEED_GOLDEN_ANGLE;
  return {
    x: anchor.x + radius * Math.cos(angle),
    y: anchor.y + radius * Math.sin(angle),
  };
}

// 노드 배열 → 렌더용 좌표/앵커 스냅샷(틱 핸들러·이펙트에서만 호출).
// 앵커는 훅 레지스트리에 의존하므로(D90 동적 슬롯) 순수성 유지를 위해 anchorFor를 인자로 받는다.
function snapshot(
  arr: LNode[],
  anchorFor: (tag: string) => { x: number; y: number },
): { positions: Positions; tagCentroids: Centroids } {
  const positions: Positions = new Map();
  const counts = new Map<string, number>();
  for (const n of arr) {
    positions.set(n.id, { x: n.x, y: n.y });
    counts.set(n.tag, (counts.get(n.tag) ?? 0) + 1);
  }
  const tagCentroids: Centroids = new Map();
  for (const [tag, count] of counts) {
    const a = anchorFor(tag);
    tagCentroids.set(tag, { x: a.x, y: a.y, count }); // 위치=태그 슬롯 앵커, populated-only
  }
  return { positions, tagCentroids };
}

export function useTagLayout(items: Array<{ id: string; tag: string; h: number }>) {
  // 틱마다 갱신되는 렌더 스냅샷(ref는 렌더 중 읽지 않도록 상태로 승격).
  const [snap, setSnap] = useState<{ positions: Positions; tagCentroids: Centroids }>(() => ({
    positions: new Map(),
    tagCentroids: new Map(),
  }));
  // 틱마다 갱신되는 **최신** 좌표. 상태(snap)와 같은 내용이지만 리렌더를 거치지
  // 않고 읽을 수 있다 — 카메라 추종처럼 "매 프레임 최신 좌표"가 필요한 쪽이
  // positions 상태에 의존하면, 틱 → 렌더 → 이펙트 → setState → … 로 이어지는
  // 업데이트 사슬이 생겨 React 중첩 업데이트 한도에 걸린다(2026-07-27 실측).
  const positionsRef = useRef<Positions>(new Map());
  const simRef = useRef<Simulation<LNode, undefined> | null>(null);
  const nodesRef = useRef<Map<string, LNode>>(new Map());
  // 태그별 카드 개수(결정론 시드 오프셋용) — 세션 동안 누적.
  const tagCountRef = useRef<Map<string, number>>(new Map());
  // 태그 → 슬롯 번호 레지스트리(D90). 첫 등장 순서로 슬롯을 영구 부여.
  const tagSlotRef = useRef<Map<string, number>>(new Map());

  // 태그의 앵커: "기타"/빈 태그는 중앙(슬롯 미등록), 그 외 첫 등장 시 다음 슬롯
  // 번호를 영구 부여(D90). 재수화가 created_at 순 재생이라 첫 등장 순서가
  // 결정론 — 같은 세션은 항상 같은 배치. 카드가 사라져도 슬롯은 해제하지 않는다
  // (남은 카드 위치 안정 우선). ref만 읽으므로 렌더마다 재생성돼도 동작 불변.
  const anchorFor = (tag: string): { x: number; y: number } => {
    const t = (tag || "").trim();
    if (!t || t === "기타") return CENTER; // 폴백은 중앙(ConceptCanvasWorkspace DEFAULT_TAG와 일치)
    const reg = tagSlotRef.current;
    let slot = reg.get(t);
    if (slot === undefined) {
      slot = reg.size; // 다음 슬롯 = 현재 등록 개수(첫 등장 순서, 0-base)
      reg.set(t, slot);
    }
    return slotAnchor(slot);
  };

  // 입력 items의 키를 **두 갈래**로 쪼갠다(2026-07-27).
  //
  //   구성원 키 — 카드 id·태그. 바뀌면 배치 자체가 달라지므로 재가열해야 한다.
  //   크기 키   — 높이. 스트리밍 중 본문이 늘면서 **토큰마다** 바뀐다.
  //
  // 예전엔 둘이 한 키였다. 그래서 답변이 흐르는 내내 매 토큰 sim을 alpha 0.9로
  // 재가열했고, 그 위에 틱마다 setSnap이 얹혀 React가 중첩 업데이트 한도(50)를
  // 넘겼다 — 콘솔에 "Maximum update depth exceeded"가 질문 1회당 3~4건씩
  // 쌓였다(2026-07-27 실측). 높이 변화는 재가열 없이 충돌 반경만 갱신한다.
  const memberSig = items.map((i) => `${i.id}:${i.tag}`).join("|");
  const sizeSig = items.map((i) => Math.round(i.h)).join(",");

  useEffect(() => {
    const nodes = nodesRef.current;
    const seen = new Set<string>();
    for (const it of items) {
      const tag = (it.tag || "").trim() || "기타";
      seen.add(it.id);
      let n = nodes.get(it.id);
      if (!n) {
        const cardIdx = tagCountRef.current.get(tag) ?? 0;
        tagCountRef.current.set(tag, cardIdx + 1);
        // 자기 태그 슬롯 앵커 근처로 시드(결정론 소나선 → 초기 겹침 방지, 즉시 제자리).
        const seed = seedNear(anchorFor(tag), cardIdx);
        n = { id: it.id, tag, h: it.h, x: seed.x, y: seed.y };
        nodes.set(it.id, n);
      } else {
        n.tag = tag;
        n.h = it.h;
      }
    }
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);

    const arr = [...nodes.values()];
    // 태그 응집: 각 카드를 자기 태그의 "슬롯 앵커"로 당김(무게중심 아님 → 태그 위치 고정).
    const cohesion = (alpha: number) => {
      for (const n of arr) {
        const a = anchorFor(n.tag);
        n.vx = (n.vx ?? 0) + (a.x - n.x) * COHESION * alpha;
        n.vy = (n.vy ?? 0) + (a.y - n.y) * COHESION * alpha;
      }
    };
    // 틱마다 현재 노드 좌표를 스냅샷 상태로 밀어 리렌더(ref 읽기는 여기서만).
    const publish = (next: { positions: Positions; tagCentroids: Centroids }) => {
      positionsRef.current = next.positions;
      setSnap(next);
    };
    const onTick = () => publish(snapshot(arr, anchorFor));

    let sim = simRef.current;
    if (!sim) {
      sim = forceSimulation<LNode>(arr)
        .force("charge", forceManyBody<LNode>().strength(CHARGE))
        .force("collide", forceCollide<LNode>(collideRadius))
        .force("cohesion", cohesion)
        .alphaMin(0.02)
        .on("tick", onTick);
      simRef.current = sim;
    } else {
      sim.nodes(arr);
      sim.force("collide", forceCollide<LNode>(collideRadius));
      sim.force("cohesion", cohesion);
      sim.on("tick", onTick);
      sim.alpha(0.9).restart(); // 재가열 → 전체 재배치 애니메이션
    }
    // 시드/재조정 직후 초기 좌표를 한 번 반영(틱 이전에도 위치 노출).
    publish(snapshot(arr, anchorFor));
    return () => {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberSig]);

  // 카드 높이만 바뀐 경우(= 스트리밍 중 본문이 자라는 경우). 노드를 새로 만들지도,
  // sim을 재가열하지도 않는다 — 충돌 반경만 새 높이로 갈아끼운다.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const nodes = nodesRef.current;
    for (const it of items) {
      const n = nodes.get(it.id);
      if (n) n.h = it.h;
    }
    sim.force("collide", forceCollide<LNode>(collideRadius));
    // 이미 다 식어 멈춘 sim이면 새 크기가 화면에 반영되지 않으므로 약하게 깨운다.
    // 가열 중일 때(= 스트리밍 도중 대부분)는 아무 것도 하지 않는다 — 여기서
    // restart하면 위에서 없앤 토큰마다 재가열이 그대로 되살아난다.
    if (sim.alpha() <= sim.alphaMin()) sim.alpha(RESIZE_NUDGE).restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeSig]);

  useEffect(() => () => { simRef.current?.stop(); }, []);

  return {
    positions: snap.positions,
    tagCentroids: snap.tagCentroids,
    positionsRef,
  };
}
