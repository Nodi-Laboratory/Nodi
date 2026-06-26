"use client";

import { useMemo } from "react";
import * as d3 from "d3";
import type { CooccurrenceRow, TagRow } from "@/lib/types";

/**
 * 개념 "나무 수관(canopy)" 시각화 — force-graph 아님(안정적 정적 레이아웃).
 *
 * - 태그 = 잎: d3.pack 원형 패킹으로 한 덩어리 수관처럼 뭉치고, 크기는 usage_count.
 * - co-occurrence = 함께 등장한 태그를 잇는 잔가지(잎 사이 선, 굵기=동시출현 횟수).
 * - 함께 묶이는 군집(union-find)마다 잎 색을 노란 계열 내에서 미세하게 달리해 군집감.
 * - 아래에 줄기/뿌리(대화=뿌리 은유)를 가볍게.
 * 멀리서 보면 한 그루 나무의 수관처럼 보이도록 의도.
 */

const VIEW_W = 1000;
const VIEW_H = 720;
const PACK = 460; // 패킹 정사각 변
const CX = VIEW_W / 2;
const TOP = 60; // 수관 상단 여백
const OFFSET_X = CX - PACK / 2;

// 노란 계열 잎 색(군집별 미세 변주)
const LEAF_SHADES = ["#fcf58b", "#f7e96f", "#fbeaa0", "#f4e070", "#fdf3b4"];

interface Leaf {
  id: string;
  name: string;
  usage: number;
  x: number;
  y: number;
  r: number;
  shade: string;
}

interface Branch {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

type PackDatum = { tag?: TagRow; children?: PackDatum[] };

function computeClusters(
  tags: TagRow[],
  cooc: CooccurrenceRow[],
): Map<string, number> {
  const parent = new Map<string, string>();
  tags.forEach((t) => parent.set(t.id, t.id));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    parent.set(find(a), find(b));
  };
  cooc.forEach((c) => union(c.tag_a, c.tag_b));

  const rootToIndex = new Map<string, number>();
  const result = new Map<string, number>();
  tags.forEach((t) => {
    const root = find(t.id);
    if (!rootToIndex.has(root)) rootToIndex.set(root, rootToIndex.size);
    result.set(t.id, rootToIndex.get(root)!);
  });
  return result;
}

export function ConceptCanopy({
  tags,
  cooccurrence,
}: {
  tags: TagRow[];
  cooccurrence: CooccurrenceRow[];
}) {
  const { leaves, branches } = useMemo(() => {
    if (tags.length === 0) {
      return { leaves: [] as Leaf[], branches: [] as Branch[] };
    }

    const clusters = computeClusters(tags, cooccurrence);

    const data: PackDatum = { children: tags.map((t) => ({ tag: t })) };
    const root = d3
      .hierarchy<PackDatum>(data)
      .sum((d) => (d.tag ? d.tag.usage_count + 1 : 0));
    const packed = d3
      .pack<PackDatum>()
      .size([PACK, PACK])
      .padding(6)(root);

    const posById = new Map<string, { x: number; y: number; r: number }>();
    const leaves: Leaf[] = packed.leaves().map((node) => {
      const tag = node.data.tag!;
      const x = node.x + OFFSET_X;
      const y = node.y + TOP;
      const r = node.r;
      posById.set(tag.id, { x, y, r });
      const cluster = clusters.get(tag.id) ?? 0;
      return {
        id: tag.id,
        name: tag.name,
        usage: tag.usage_count,
        x,
        y,
        r,
        shade: LEAF_SHADES[cluster % LEAF_SHADES.length],
      };
    });

    const maxCount = Math.max(1, ...cooccurrence.map((c) => c.count));
    const branches: Branch[] = [];
    cooccurrence.forEach((c) => {
      const a = posById.get(c.tag_a);
      const b = posById.get(c.tag_b);
      if (!a || !b) return;
      branches.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        width: 0.8 + (c.count / maxCount) * 2.4,
      });
    });

    return { leaves, branches };
  }, [tags, cooccurrence]);

  // 수관 중심/반경(트렁크 위치 계산용)
  const canopyCy = TOP + PACK / 2;
  const canopyBottom = TOP + PACK; // 대략적 수관 하단

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      role="img"
      aria-label="개념 나무 수관"
    >
      <defs>
        <radialGradient id="leafGrad" cx="38%" cy="34%" r="70%">
          <stop offset="0%" stopColor="#fffdf0" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <filter id="canopyBlur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="22" />
        </filter>
      </defs>

      {/* 줄기 (trunk) */}
      <path
        d={`M ${CX - 22} ${canopyCy}
            C ${CX - 30} ${canopyBottom + 40}, ${CX - 34} ${VIEW_H - 90}, ${CX - 30} ${VIEW_H - 60}
            L ${CX + 30} ${VIEW_H - 60}
            C ${CX + 34} ${VIEW_H - 90}, ${CX + 30} ${canopyBottom + 40}, ${CX + 22} ${canopyCy} Z`}
        fill="#6b4e13"
        opacity="0.85"
      />

      {/* 뿌리 (대화 = 뿌리 은유) */}
      <g stroke="#6b4e13" strokeOpacity="0.4" fill="none" strokeLinecap="round">
        <path d={`M ${CX} ${VIEW_H - 62} C ${CX - 40} ${VIEW_H - 40}, ${CX - 70} ${VIEW_H - 30}, ${CX - 110} ${VIEW_H - 18}`} strokeWidth="3" />
        <path d={`M ${CX} ${VIEW_H - 62} C ${CX - 10} ${VIEW_H - 34}, ${CX - 20} ${VIEW_H - 22}, ${CX - 30} ${VIEW_H - 10}`} strokeWidth="2.5" />
        <path d={`M ${CX} ${VIEW_H - 62} C ${CX + 10} ${VIEW_H - 34}, ${CX + 24} ${VIEW_H - 22}, ${CX + 34} ${VIEW_H - 10}`} strokeWidth="2.5" />
        <path d={`M ${CX} ${VIEW_H - 62} C ${CX + 40} ${VIEW_H - 40}, ${CX + 72} ${VIEW_H - 30}, ${CX + 112} ${VIEW_H - 18}`} strokeWidth="3" />
      </g>

      {/* 수관 실루엣 (멀리서 본 나무 윗부분) */}
      <ellipse
        cx={CX}
        cy={canopyCy}
        rx={PACK / 2 + 12}
        ry={PACK / 2 - 6}
        fill="#6e8a3c"
        opacity="0.12"
        filter="url(#canopyBlur)"
      />

      {/* 잔가지 (co-occurrence) */}
      <g stroke="#6b4e13" fill="none" strokeLinecap="round">
        {branches.map((b, i) => (
          <line
            key={i}
            x1={b.x1}
            y1={b.y1}
            x2={b.x2}
            y2={b.y2}
            strokeWidth={b.width}
            strokeOpacity={0.18}
          />
        ))}
      </g>

      {/* 잎 (태그) */}
      <g>
        {leaves.map((leaf) => {
          const showLabel = leaf.r >= 20;
          const fontSize = Math.max(9, Math.min(16, leaf.r * 0.5));
          return (
            <g key={leaf.id}>
              <title>{`${leaf.name} · ${leaf.usage}회`}</title>
              <circle
                cx={leaf.x}
                cy={leaf.y}
                r={leaf.r}
                fill={leaf.shade}
                stroke="#c9a227"
                strokeWidth={1}
              />
              <circle
                cx={leaf.x}
                cy={leaf.y}
                r={leaf.r}
                fill="url(#leafGrad)"
                pointerEvents="none"
              />
              {showLabel && (
                <text
                  x={leaf.x}
                  y={leaf.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={fontSize}
                  fontWeight={600}
                  fill="#3a3320"
                  pointerEvents="none"
                >
                  {leaf.name.length > 6
                    ? leaf.name.slice(0, 6) + "…"
                    : leaf.name}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
