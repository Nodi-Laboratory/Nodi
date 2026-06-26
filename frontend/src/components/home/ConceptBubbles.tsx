"use client";

import { useMemo } from "react";
import * as d3 from "d3";
import type { HomeConcept } from "@/lib/types";

/**
 * 홈 개념 박스 — 많이 쓴 개념을 큰 노란 버블 묶음으로(usage_count 클수록 큼).
 * d3.pack 정적 패킹(force-graph 아님). 클릭/자세히는 부모가 /concepts로 연결.
 */
const W = 640;
const H = 240;
const SHADES = ["#fcf58b", "#f7e96f", "#fbeaa0", "#f4e070"];

interface Bubble {
  id: string;
  name: string;
  usage: number;
  x: number;
  y: number;
  r: number;
  shade: string;
}

type PackDatum = { concept?: HomeConcept; children?: PackDatum[] };

export function ConceptBubbles({ concepts }: { concepts: HomeConcept[] }) {
  const bubbles = useMemo<Bubble[]>(() => {
    if (concepts.length === 0) return [];
    const S = Math.min(W, H) - 16;
    const data: PackDatum = { children: concepts.map((c) => ({ concept: c })) };
    const root = d3
      .hierarchy<PackDatum>(data)
      .sum((d) => (d.concept ? d.concept.usage_count + 1 : 0));
    const packed = d3.pack<PackDatum>().size([S, S]).padding(5)(root);
    const offX = (W - S) / 2;
    const offY = (H - S) / 2;
    return packed.leaves().map((node, i) => {
      const c = node.data.concept!;
      return {
        id: c.id,
        name: c.name,
        usage: c.usage_count,
        x: node.x + offX,
        y: node.y + offY,
        r: node.r,
        shade: SHADES[i % SHADES.length],
      };
    });
  }, [concepts]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      role="img"
      aria-label="많이 쓴 개념"
    >
      <defs>
        <radialGradient id="bubbleGrad" cx="38%" cy="34%" r="70%">
          <stop offset="0%" stopColor="#fffdf0" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {bubbles.map((b) => {
        const showLabel = b.r >= 18;
        const fontSize = Math.max(9, Math.min(15, b.r * 0.5));
        return (
          <g key={b.id}>
            <title>{`${b.name} · ${b.usage}회`}</title>
            <circle
              cx={b.x}
              cy={b.y}
              r={b.r}
              fill={b.shade}
              stroke="#c9a227"
              strokeWidth={1}
            />
            <circle cx={b.x} cy={b.y} r={b.r} fill="url(#bubbleGrad)" />
            {showLabel && (
              <text
                x={b.x}
                y={b.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fontSize}
                fontWeight={600}
                fill="#3a3320"
              >
                {b.name.length > 6 ? b.name.slice(0, 6) + "…" : b.name}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
