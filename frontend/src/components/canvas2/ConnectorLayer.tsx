"use client";

/**
 * 연결선 (D126) — 학생의 글과 그에 대한 AI 응답을 잇는다.
 *
 * "AI의 응답"이라는 것이 보여야 한다는 지시였다. 선 하나로는 방향이 안
 * 읽히므로 **곡선 + 시작점 도트 + 중간 라벨**로 셋을 갖춘다. 색은 파랑(AI)이다.
 *
 * 오버레이 안에 있으므로 좌표는 그대로 world다 — 팬/줌은 부모 변환이 처리한다.
 */

import { ITEM_W } from "@/lib/canvas2/layout";
import type { Placed } from "@/lib/canvas2/layout";
import type { CanvasItem } from "@/lib/canvas2/types";

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  heights: Map<string, number>;
}

const FALLBACK_H = 180;

export function ConnectorLayer({ items, positions, heights }: Props) {
  const links = items
    .filter((i) => i.parentItemId && positions.has(i.id) && positions.has(i.parentItemId))
    .map((child) => {
      const cp = positions.get(child.id)!;
      const pp = positions.get(child.parentItemId!)!;
      const ph = heights.get(child.parentItemId!) ?? FALLBACK_H;
      const ch = heights.get(child.id) ?? FALLBACK_H;
      return {
        id: child.id,
        // 부모 오른쪽 변 중앙 → 자식 왼쪽 변 중앙
        x1: pp.x + ITEM_W,
        y1: pp.y + Math.min(ph / 2, 60),
        x2: cp.x,
        y2: cp.y + Math.min(ch / 2, 60),
      };
    });

  if (!links.length) return null;

  // SVG 하나로 전부 그린다. 링크마다 SVG를 만들면 요소가 폭발한다.
  const pad = 400;
  const xs = links.flatMap((l) => [l.x1, l.x2]);
  const ys = links.flatMap((l) => [l.y1, l.y2]);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - minX + pad;
  const h = Math.max(...ys) - minY + pad;

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute"
      style={{ left: minX, top: minY, width: w, height: h, overflow: "visible" }}
      viewBox={`0 0 ${w} ${h}`}
    >
      {links.map((l) => {
        const x1 = l.x1 - minX;
        const y1 = l.y1 - minY;
        const x2 = l.x2 - minX;
        const y2 = l.y2 - minY;
        const mx = (x1 + x2) / 2;
        return (
          <g key={l.id} style={{ color: "var(--c-live-deep)" }}>
            <path
              d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              opacity={0.35}
            />
            <circle cx={x1} cy={y1} r={3} fill="currentColor" opacity={0.5} />
            <text
              x={mx}
              y={(y1 + y2) / 2 - 6}
              textAnchor="middle"
              fill="currentColor"
              opacity={0.75}
              style={{
                fontFamily: "var(--font-label), monospace",
                fontSize: 10,
                letterSpacing: "0.04em",
              }}
            >
              AI 응답
            </text>
          </g>
        );
      })}
    </svg>
  );
}
