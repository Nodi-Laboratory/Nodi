"use client";

// D3 위치 미니맵 — 클러스터를 실제 맵 위치의 축소 점으로 렌더. d3.scaleLinear로 좌표를
// 매핑(계산), SVG는 React가 렌더(React 19 안전). 점 클릭 → onFocus(클러스터 월드 중심).

import { useMemo } from "react";
import { scaleLinear } from "d3-scale";
import type { Concept, ConceptGroup } from "@/lib/concept/types";
import {
  groupCentroids,
  worldBBox,
  fitTransform,
  viewportRectPx,
} from "@/lib/concept/minimapLayout";

const W = 260;
const H = 180;
const PAD = 16;

export default function ConceptMinimap({
  groups,
  concepts,
  camera,
  viewport,
  activeId,
  onFocus,
}: {
  groups: ConceptGroup[];
  concepts: Concept[];
  camera: { x: number; y: number; scale: number };
  viewport: { w: number; h: number };
  activeId: string | null;
  onFocus: (target: { x: number; y: number }) => void;
}) {
  const nodes = useMemo(() => groupCentroids(groups, concepts), [groups, concepts]);
  const bbox = useMemo(
    () => worldBBox(nodes.map((n) => ({ wx: n.wx, wy: n.wy }))),
    [nodes],
  );

  if (!bbox) {
    return <p style={{ margin: 12, fontSize: 13, opacity: 0.6 }}>질문하면 개념이 여기 모여요.</p>;
  }

  const fit = fitTransform(bbox, W, H, PAD);
  // d3.scaleLinear로 월드→픽셀 매핑(동일 배율 s를 양축에 적용 → 종횡비 보존).
  const sx = scaleLinear().domain([bbox.minX, bbox.maxX]).range([fit.ox + bbox.minX * fit.s, fit.ox + bbox.maxX * fit.s]);
  const sy = scaleLinear().domain([bbox.minY, bbox.maxY]).range([fit.oy + bbox.minY * fit.s, fit.oy + bbox.maxY * fit.s]);
  const vr = viewportRectPx(camera, viewport, fit);

  return (
    <svg width={W} height={H} data-testid="concept-minimap" data-no-pan style={{ display: "block" }}>
      <rect x={0} y={0} width={W} height={H} rx={10} fill="rgba(43,38,32,.04)" />
      {/* 현재 카메라 가시영역 */}
      <rect
        x={vr.x}
        y={vr.y}
        width={vr.w}
        height={vr.h}
        fill="none"
        stroke="rgba(43,38,32,.35)"
        strokeWidth={1}
        rx={3}
      />
      {nodes.map((n) => {
        const cx = sx(n.wx);
        const cy = sy(n.wy);
        const r = Math.max(6, Math.min(22, 6 + Math.sqrt(n.count) * 3));
        const active = n.repConceptId === activeId;
        return (
          <g
            key={n.id}
            transform={`translate(${cx},${cy})`}
            style={{ cursor: "pointer" }}
            onClick={() => onFocus({ x: n.wx, y: n.wy })}
          >
            <circle
              r={r}
              fill={active ? "var(--hl-yellow, #FFC526)" : "rgba(43,38,32,.55)"}
              stroke="#fff"
              strokeWidth={1.5}
            />
            <text
              x={0}
              y={r + 11}
              textAnchor="middle"
              fontSize={10}
              fill="var(--ink, #2b2620)"
              style={{ pointerEvents: "none" }}
            >
              {n.label.length > 8 ? n.label.slice(0, 8) + "…" : n.label}
            </text>
            {n.count > 1 && (
              <text x={0} y={3} textAnchor="middle" fontSize={9} fill="#fff" style={{ pointerEvents: "none" }}>
                {n.count}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
