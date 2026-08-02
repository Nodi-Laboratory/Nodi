"use client";

/**
 * 연결선 (D126) — 학생의 글과 그에 대한 AI 응답을 잇는다.
 *
 * "AI의 응답"이라는 것이 보여야 한다는 지시였다. 선 하나로는 방향이 안
 * 읽히므로 **곡선 + 양끝 도트 + 중간 라벨**로 셋을 갖춘다.
 *
 * 선이 생기는 경우는 하나뿐이다 — 학생이 자기 글에서 **"AI에게 묻기"**를 했을
 * 때. 하단 입력창의 평범한 질문은 상자를 더 만들지 않는다(useCanvasStream).
 *
 * ## 붙는 자리는 고정이 아니다
 *
 * 예전에는 언제나 "부모 오른쪽 변 → 자식 왼쪽 변"이었다. 답을 질문 **위쪽**으로
 * 끌어 올리면 선이 오른쪽으로 나갔다 크게 되돌아왔고, 답이 둘이면 시작점이 같은
 * 한 점이라 두 선이 겹쳐 지나갔다. 지금은 두 사각형의 **상대 위치**로 변을 고르고,
 * 변 위 지점도 상대에 맞춰 미끄러진다(`lib/canvas2/connector.ts`).
 *
 * 끝점은 글자 사각형이 아니라 **패딩 상자**의 변에 앉는다 — hover 시 깔리는
 * 박스와 같은 크기라, 눈에 보이는 상자에서 선이 나오는 것으로 읽힌다.
 *
 * ## 드래그를 따라간다
 *
 * 아이템은 드래그 중 React를 거치지 않고 DOM transform으로 움직인다. 그래서
 * 여기도 React 밖에서 따라가야 한다 — `dragBus`로 이동량을 받아 path·도트·라벨
 * 속성을 직접 고친다. 안 그러면 상자만 가고 선은 제자리에 남는다(사용자 지적).
 *
 * 오버레이 안에 있으므로 좌표는 그대로 world다 — 팬/줌은 부모 변환이 처리한다.
 */

import { useEffect, useRef } from "react";
import type { Placed } from "@/lib/canvas2/layout";
import type { Size } from "@/lib/canvas2/useItemLayout";
import type { CanvasItem } from "@/lib/canvas2/types";
import type { Rect } from "@/lib/canvas2/rect";
import { linkGeometry, midpoint } from "@/lib/canvas2/connector";
import { treeEdges } from "@/lib/canvas2/tree";
import { useCollapsible } from "@/lib/canvas2/useCollapsible";
import { getDragOffsets, subscribeDrag, type DragOffset } from "@/lib/canvas2/dragBus";

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  sizes: Map<string, Size>;
}

const FALLBACK: Size = { w: 460, h: 180 };
/** 도트 반지름. */
const DOT_R = 3.5;
/** SVG 화폭 여유. 드래그로 선이 밖으로 나가도 `overflow:visible`이 받아 준다. */
const PAD = 400;

interface Link {
  id: string;
  parentId: string;
  parent: Rect;
  child: Rect;
  /**
   * 태그 트리의 간선인가 (D151).
   *
   * 트리 간선은 **수가 많다**(카드마다 하나). 옛 "AI에게 묻기" 선처럼 라벨을
   * 달고 굵게 그리면 캔버스가 글자보다 선으로 뒤덮인다. 가늘게, 라벨 없이,
   * 방향만 보이게 그린다.
   */
  tree: boolean;
}

function shift(r: Rect, o: DragOffset | undefined): Rect {
  return o ? { ...r, x: r.x + o.dx, y: r.y + o.dy } : r;
}

export function ConnectorLayer({ items, positions, sizes }: Props) {
  /**
   * 캔버스에도 트리 선을 그릴 것인가 (D151, 사용자 지시 — 기본 켬).
   *
   * 지도의 "캔버스에도 선 보이게 하기" 버튼과 **같은 저장소를 본다**. 상태를
   * prop으로 내리지 않는 이유는 둘이 형제도 부모-자식도 아니어서다 — 같은 키를
   * 보면 어긋날 수가 없다.
   */
  const { open: edgesOnCanvas } = useCollapsible("canvas-edges", true);
  const treeChildIds = new Set(treeEdges(items).map((e) => e.to));

  const links: Link[] = items
    .filter((i) => i.parentItemId && positions.has(i.id) && positions.has(i.parentItemId))
    .filter((i) => (treeChildIds.has(i.id) ? edgesOnCanvas : true))
    .map((child) => {
      const cp = positions.get(child.id)!;
      const pp = positions.get(child.parentItemId!)!;
      const cs = sizes.get(child.id) ?? FALLBACK;
      const ps = sizes.get(child.parentItemId!) ?? FALLBACK;
      return {
        id: child.id,
        parentId: child.parentItemId!,
        parent: { x: pp.x, y: pp.y, w: ps.w, h: ps.h },
        child: { x: cp.x, y: cp.y, w: cs.w, h: cs.h },
        tree: treeChildIds.has(child.id),
      };
    });

  // 화폭 — 드래그 중에는 갱신하지 않는다(SVG는 overflow:visible이라 밖에도 그려진다).
  const geos = links.map((l) => linkGeometry(l.parent, l.child));
  const xs = geos.flatMap((g) => [g.a.x, g.b.x, g.c1.x, g.c2.x]);
  const ys = geos.flatMap((g) => [g.a.y, g.b.y, g.c1.y, g.c2.y]);
  const minX = xs.length ? Math.min(...xs) - PAD : 0;
  const minY = ys.length ? Math.min(...ys) - PAD : 0;
  const w = xs.length ? Math.max(...xs) - minX + PAD : 0;
  const h = ys.length ? Math.max(...ys) - minY + PAD : 0;

  const svgRef = useRef<SVGSVGElement>(null);
  // 드래그 콜백이 최신 링크·원점을 보게 한다(구독은 한 번만 건다).
  // **렌더 중에 ref를 쓰지 않는다** — React Compiler가 막는다(react-hooks/refs).
  const stateRef = useRef({ links, minX, minY });
  useEffect(() => {
    stateRef.current = { links, minX, minY };
  });

  useEffect(() => {
    const draw = (offsets: ReadonlyMap<string, DragOffset>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const { links: ls, minX: ox, minY: oy } = stateRef.current;
      for (const l of ls) {
        // 노드마다 ref를 다는 대신 조회한다. ref 콜백을 렌더에서 만들면
        // 그 안의 `ref.current` 접근이 렌더 중 접근으로 잡힌다.
        const g0 = svg.querySelector<SVGGElement>(`[data-link="${CSS.escape(l.id)}"]`);
        const path = g0?.querySelector("path");
        if (!path) continue;
        const n = {
          path,
          from: g0!.querySelector<SVGCircleElement>('[data-end="from"]'),
          to: g0!.querySelector<SVGCircleElement>('[data-end="to"]'),
          label: g0!.querySelector("text"),
        };
        const g = linkGeometry(
          shift(l.parent, offsets.get(l.parentId)),
          shift(l.child, offsets.get(l.id)),
        );
        const m = midpoint(g);
        path.setAttribute(
          "d",
          `M ${g.a.x - ox} ${g.a.y - oy} C ${g.c1.x - ox} ${g.c1.y - oy}, ` +
            `${g.c2.x - ox} ${g.c2.y - oy}, ${g.b.x - ox} ${g.b.y - oy}`,
        );
        n.from?.setAttribute("cx", String(g.a.x - ox));
        n.from?.setAttribute("cy", String(g.a.y - oy));
        n.to?.setAttribute("cx", String(g.b.x - ox));
        n.to?.setAttribute("cy", String(g.b.y - oy));
        n.label?.setAttribute("x", String(m.x - ox));
        n.label?.setAttribute("y", String(m.y - oy - 6));
      }
    };
    // 마운트 직후에도 한 번 맞춘다 — 드래그 도중에 아이템이 새로 그려지면
    // React가 낸 정적 좌표로 되돌아가 있을 수 있다.
    draw(getDragOffsets());
    return subscribeDrag(draw);
  }, []);

  if (!links.length) return null;

  return (
    <svg
      aria-hidden
      ref={svgRef}
      className="pointer-events-none absolute"
      style={{ left: minX, top: minY, width: w, height: h, overflow: "visible" }}
      viewBox={`0 0 ${w} ${h}`}
    >
      {links.map((l, i) => {
        const g = geos[i];
        const m = midpoint(g);
        return (
          <g key={l.id} data-link={l.id} style={{ color: "var(--c-live-deep)" }}>
            <path
              d={
                `M ${g.a.x - minX} ${g.a.y - minY} C ${g.c1.x - minX} ${g.c1.y - minY}, ` +
                `${g.c2.x - minX} ${g.c2.y - minY}, ${g.b.x - minX} ${g.b.y - minY}`
              }
              fill="none"
              stroke="currentColor"
              strokeWidth={l.tree ? 1.1 : 1.5}
              strokeLinecap="round"
              opacity={l.tree ? 0.28 : 0.4}
            />
            {/* 양끝 도트 — 어디서 나와 어디로 갔는지가 한눈에 보인다.
                받는 쪽만 가운데를 종이색으로 비워 방향을 표시한다. */}
            <circle
              data-end="from"
              cx={g.a.x - minX}
              cy={g.a.y - minY}
              r={l.tree ? DOT_R - 1 : DOT_R}
              fill="currentColor"
              opacity={l.tree ? 0.5 : 0.85}
            />
            <circle
              data-end="to"
              cx={g.b.x - minX}
              cy={g.b.y - minY}
              r={l.tree ? DOT_R - 1 : DOT_R}
              fill="var(--c-paper)"
              stroke="currentColor"
              strokeWidth={1.5}
              opacity={l.tree ? 0.6 : 0.95}
            />
            {/* 트리 간선에는 라벨을 달지 않는다 — 카드마다 하나씩이라
                "AI 응답"이 캔버스를 뒤덮는다 (D151). */}
            {!l.tree && (
            <text
              x={m.x - minX}
              y={m.y - minY - 6}
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
            )}
          </g>
        );
      })}
    </svg>
  );
}
