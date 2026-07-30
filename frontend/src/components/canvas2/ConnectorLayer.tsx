"use client";

/**
 * 연결선 (D126) — 학생의 글과 그에 대한 AI 응답을 잇는다.
 *
 * "AI의 응답"이라는 것이 보여야 한다는 지시였다. 선 하나로는 방향이 안
 * 읽히므로 **곡선 + 양끝 도트 + 중간 라벨**로 셋을 갖춘다.
 *
 * ## 붙는 자리는 고정이 아니다
 *
 * 예전에는 언제나 "부모 오른쪽 변 → 자식 왼쪽 변"이었다. 학생이 답을 질문
 * **위쪽**으로 끌어 올리면 선이 오른쪽으로 나갔다가 크게 되돌아왔고, 답이 둘이면
 * 시작점이 같은 한 점이라 두 선이 겹쳐 지나갔다(사용자가 보낸 이미지의 문제).
 *
 * 지금은 두 사각형의 **상대 위치**로 어느 변에서 나갈지 정한다:
 *
 *     답이 오른쪽에  →  부모 오른쪽 변  →  자식 왼쪽 변
 *     답이 아래에    →  부모 아래 변    →  자식 윗 변
 *     답이 위에      →  부모 윗 변      →  자식 아래 변
 *
 * 게다가 변 위에서의 **위치**도 상대에 맞춰 미끄러진다 — 답이 둘이면 하나는
 * 위쪽에서, 하나는 아래쪽에서 나가므로 겹치지 않는다.
 *
 * ## 끝점은 박스 **밖**에 선다
 *
 * 예전에는 변 좌표를 그대로 써서 도트가 박스 테두리에 걸치거나 안쪽에 박혔다.
 * `END_GAP`만큼 바깥으로 물려서 "여기서 나왔다"가 보이게 한다.
 *
 * 오버레이 안에 있으므로 좌표는 그대로 world다 — 팬/줌은 부모 변환이 처리한다.
 */

import type { Placed } from "@/lib/canvas2/layout";
import type { Size } from "@/lib/canvas2/useItemLayout";
import type { CanvasItem } from "@/lib/canvas2/types";
import type { Rect } from "@/lib/canvas2/rect";
import { linkGeometry, midpoint } from "@/lib/canvas2/connector";

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  sizes: Map<string, Size>;
}

const FALLBACK: Size = { w: 460, h: 180 };
/** 도트 반지름. */
const DOT_R = 3.5;

export function ConnectorLayer({ items, positions, sizes }: Props) {
  const links = items
    .filter((i) => i.parentItemId && positions.has(i.id) && positions.has(i.parentItemId))
    .map((child) => {
      const cp = positions.get(child.id)!;
      const pp = positions.get(child.parentItemId!)!;
      const cs = sizes.get(child.id) ?? FALLBACK;
      const ps = sizes.get(child.parentItemId!) ?? FALLBACK;

      const parent: Rect = { x: pp.x, y: pp.y, w: ps.w, h: ps.h };
      const kid: Rect = { x: cp.x, y: cp.y, w: cs.w, h: cs.h };
      const g = linkGeometry(parent, kid);
      const m = midpoint(g);

      return {
        id: child.id,
        x1: g.a.x,
        y1: g.a.y,
        x2: g.b.x,
        y2: g.b.y,
        c1x: g.c1.x,
        c1y: g.c1.y,
        c2x: g.c2.x,
        c2y: g.c2.y,
        mx: m.x,
        my: m.y,
      };
    });

  if (!links.length) return null;

  // SVG 하나로 전부 그린다. 링크마다 SVG를 만들면 요소가 폭발한다.
  const pad = 400;
  const xs = links.flatMap((l) => [l.x1, l.x2, l.c1x, l.c2x]);
  const ys = links.flatMap((l) => [l.y1, l.y2, l.c1y, l.c2y]);
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
        const c1x = l.c1x - minX;
        const c1y = l.c1y - minY;
        const c2x = l.c2x - minX;
        const c2y = l.c2y - minY;
        // 라벨은 곡선의 t=0.5 위에 얹는다(connector.ts). 두 끝의 중점에 두면
        // 곡선이 휜 만큼 선에서 떨어져 보인다.
        const mx = l.mx - minX;
        const my = l.my - minY;
        return (
          <g key={l.id} style={{ color: "var(--c-live-deep)" }}>
            <path
              d={`M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              opacity={0.4}
            />
            {/* 양끝 도트 — 어디서 나와 어디로 갔는지가 한눈에 보인다.
                가운데를 종이색으로 비워 선이 도트를 관통해 보이지 않게 한다. */}
            <circle cx={x1} cy={y1} r={DOT_R} fill="currentColor" opacity={0.85} />
            <circle
              cx={x2}
              cy={y2}
              r={DOT_R}
              fill="var(--c-paper)"
              stroke="currentColor"
              strokeWidth={1.5}
              opacity={0.95}
            />
            <text
              x={mx}
              y={my - 6}
              textAnchor="middle"
              fill="currentColor"
              opacity={0.75}
              style={{
                fontFamily: "var(--font-label), monospace",
                fontSize: 10,
                letterSpacing: "0.04em",
                paintOrder: "stroke",
                stroke: "var(--c-paper)",
                strokeWidth: 3,
                strokeLinejoin: "round",
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
