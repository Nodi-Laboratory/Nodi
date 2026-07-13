"use client";

// D3 위치 미니맵 — 태그를 실제 맵 위치(고정 앵커)의 축소 점으로 렌더(1태그=1점, count 크기).
// d3.scaleLinear로 좌표를 매핑(계산), SVG는 React가 렌더(React 19 안전).
// 점 클릭 → onFocus(태그 월드 위치).

import { useMemo } from "react";
import { scaleLinear } from "d3-scale";
import { worldBBox, fitTransform } from "@/lib/concept/minimapLayout";

// 펼쳤을 때 넉넉한 크기 + PAD는 점 반경(≤22)+라벨을 덮어 모든 노드가 한 화면에 담기게 한다.
const W = 340;
const H = 260;
const PAD = 40;

export default function ConceptMinimap({
  tagNodes,
  onFocus,
}: {
  tagNodes: Array<{ tag: string; x: number; y: number; count: number }>;
  onFocus: (target: { x: number; y: number }) => void;
}) {
  const nodes = useMemo(
    () =>
      tagNodes.map((t) => ({
        id: t.tag,
        label: t.tag,
        count: t.count,
        wx: t.x,
        wy: t.y,
      })),
    [tagNodes],
  );
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

  return (
    <svg width={W} height={H} data-testid="concept-minimap" data-no-pan style={{ display: "block" }}>
      <rect x={0} y={0} width={W} height={H} rx={12} fill="rgba(43,38,32,.04)" />
      {nodes.map((n) => {
        const cx = sx(n.wx);
        const cy = sy(n.wy);
        const r = Math.max(7, Math.min(24, 7 + Math.sqrt(n.count) * 3));
        return (
          <g
            key={n.id}
            transform={`translate(${cx},${cy})`}
            style={{ cursor: "pointer" }}
            onClick={() => onFocus({ x: n.wx, y: n.wy })}
          >
            <circle
              r={r}
              fill="rgba(43,38,32,.55)"
              stroke="#fff"
              strokeWidth={1.5}
            />
            <text
              x={0}
              y={r + 13}
              textAnchor="middle"
              fontSize={12}
              fill="var(--ink, #2b2620)"
              style={{ pointerEvents: "none" }}
            >
              {n.label.length > 9 ? n.label.slice(0, 9) + "…" : n.label}
            </text>
            {n.count > 1 && (
              <text x={0} y={4} textAnchor="middle" fontSize={10} fill="#fff" style={{ pointerEvents: "none" }}>
                {n.count}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
