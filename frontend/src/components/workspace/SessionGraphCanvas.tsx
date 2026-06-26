"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { LocateFixed } from "lucide-react";
import type { NodeRow } from "@/lib/types";
import { buildNested, pathIdSet, buildById, type TreeNode } from "@/lib/tree";

/**
 * 세션 그래프 뷰 — D3 수직 트리(위→아래), 원형 노드 + 라벨 아래.
 * Conversation-Tree의 D3 패턴을 우리 데이터 모델(1노드=Q+A, parent_id)과
 * 노란 팔레트(§9)에 맞게 재작성. 줌/팬/드래그 + 현재경로 하이라이트 + 네비게이터(점선) 렌더.
 */

// 디자인 토큰(§9) 대응 색상
const C = {
  nodeFill: "#fcf58b", // --node-fill
  nodeStroke: "#6b4e13", // --node-stroke
  nodeLabel: "#3a3320", // --node-label
  pathStroke: "#e0a32e", // --accent-deep (현재경로 강조)
  linkNormal: "#d9cfb0",
  linkPath: "#e0a32e",
  navStroke: "#7a7a6e", // --fg-muted (네비게이터 점선)
  navFill: "#fffdf7", // --bg-elevated
  labelMuted: "#7a7a6e",
} as const;

const R = 11; // 노드 반지름
const MIN_CHILD_Y_GAP = 60; // 자식이 부모 위로 올라가지 못하는 최소 수직 간격

interface Props {
  nodes: NodeRow[];
  rootNodeId: string | null;
  activeNodeId: string | null;
  onNodeClick: (id: string) => void;
}

type HNode = d3.HierarchyPointNode<TreeNode>;

export default function SessionGraphCanvas({
  nodes,
  rootNodeId,
  activeNodeId,
  onNodeClick,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const contentGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const linkGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodeGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity.translate(0, 60).scale(0.9));
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const prevRootRef = useRef<string | null>(null);
  const onNodeClickRef = useRef(onNodeClick);

  const [dim, setDim] = useState({ width: 0, height: 0 });

  // 최신 콜백을 ref에 보관 (D3 핸들러에서 stale closure 방지)
  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
  }, [onNodeClick]);

  // 컨테이너 크기 추적
  useEffect(() => {
    if (!wrapperRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        requestAnimationFrame(() => setDim({ width: r.width, height: r.height }));
      }
    });
    ro.observe(wrapperRef.current);
    return () => ro.disconnect();
  }, []);

  // SVG/레이어/줌 1회 초기화
  useEffect(() => {
    if (!svgRef.current || dim.width === 0 || contentGRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const bg = svg
      .append("rect")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("fill", "transparent")
      .style("cursor", "grab");

    const g = svg.append("g");
    contentGRef.current = g;
    linkGRef.current = g.append("g").attr("class", "links");
    nodeGRef.current = g.append("g").attr("class", "nodes");

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 2.5])
      .on("zoom", (event) => {
        g.attr("transform", event.transform.toString());
        transformRef.current = event.transform;
      })
      .on("start", () => bg.style("cursor", "grabbing"))
      .on("end", () => bg.style("cursor", "grab"));

    svg.call(zoom).on("dblclick.zoom", null);
    zoomRef.current = zoom;

    const init = d3.zoomIdentity.translate(dim.width / 2, 60).scale(0.9);
    transformRef.current = init;
    svg.call(zoom.transform, init);
  }, [dim.width, dim.height]);

  const recenter = (nodeId: string | null) => {
    if (!svgRef.current || !zoomRef.current) return;
    const pos = nodeId ? posRef.current.get(nodeId) : null;
    const target = pos ?? { x: 0, y: 60 };
    const t = d3.zoomIdentity
      .translate(dim.width / 2, dim.height / 3)
      .scale(1)
      .translate(-target.x, -target.y);
    d3.select(svgRef.current)
      .transition()
      .duration(500)
      .call(zoomRef.current.transform, t);
  };

  // 데이터 렌더링
  useEffect(() => {
    if (!contentGRef.current || !linkGRef.current || !nodeGRef.current) return;
    if (dim.width === 0) return;

    // 세션(루트) 변경 시 위치 캐시 초기화
    if (prevRootRef.current !== rootNodeId) {
      posRef.current = new Map();
      prevRootRef.current = rootNodeId;
    }

    const nested = buildNested(nodes, rootNodeId);
    const linkLayer = linkGRef.current;
    const nodeLayer = nodeGRef.current;

    if (!nested) {
      linkLayer.selectAll("*").remove();
      nodeLayer.selectAll("*").remove();
      return;
    }

    const byId = buildById(nodes);
    const onPath = pathIdSet(activeNodeId, byId);

    const layout = d3.tree<TreeNode>().nodeSize([74, 120]);
    const root = layout(d3.hierarchy(nested, (d) => d.children));
    const allNodes = root.descendants();

    // 위치 재조정: 드래그로 캐시된 위치 우선, 없으면 레이아웃 좌표
    allNodes.forEach((d) => {
      const cached = posRef.current.get(d.data.data.id);
      if (cached) {
        d.x = cached.x;
        d.y = cached.y;
      } else {
        posRef.current.set(d.data.data.id, { x: d.x, y: d.y });
      }
    });

    const linkGen = d3
      .linkVertical<d3.HierarchyPointLink<TreeNode>, HNode>()
      .x((d) => d.x)
      .y((d) => d.y);

    // ── 링크 ──
    linkLayer
      .selectAll<SVGPathElement, d3.HierarchyPointLink<TreeNode>>("path.link")
      .data(root.links(), (d) => d.target.data.data.id)
      .join(
        (enter) =>
          enter
            .append("path")
            .attr("class", "link")
            .attr("fill", "none"),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr("stroke", (d) =>
        onPath.has(d.target.data.data.id) ? C.linkPath : C.linkNormal,
      )
      .attr("stroke-width", (d) =>
        onPath.has(d.target.data.data.id) ? 2.5 : 1.5,
      )
      .attr("d", linkGen);

    const redrawLinks = () =>
      linkLayer.selectAll<SVGPathElement, d3.HierarchyPointLink<TreeNode>>(
        "path.link",
      ).attr("d", linkGen);

    // ── 노드 ──
    // id → d3 계층 노드 (드래그 시 서브트리 좌표 갱신용 빠른 조회)
    const nodeById = new Map<string, HNode>();
    allNodes.forEach((n) => nodeById.set(n.data.data.id, n));

    const drag = d3
      .drag<SVGGElement, HNode>()
      .on("start", function (event, d) {
        event.sourceEvent.stopPropagation();
        const s = d as unknown as { _moved: boolean; _dist: number };
        s._moved = false;
        s._dist = 0;
        d3.select(this).raise();
      })
      .on("drag", function (event, d) {
        const s = d as unknown as { _moved: boolean; _dist: number };
        s._dist += Math.hypot(event.dx, event.dy);
        // 클릭/드래그 구분 데드존(작은 흔들림은 클릭으로 유지)
        if (!s._moved && s._dist < 4) return;
        s._moved = true;

        const cur = posRef.current.get(d.data.data.id);
        if (!cur) return;

        const newX = cur.x + event.dx;
        let newY = cur.y + event.dy;

        // y 제약: 자식은 항상 부모보다 아래(화면상 y가 더 큼). 부모 위로 못 올림.
        if (d.parent) {
          const pPos = posRef.current.get(d.parent.data.data.id);
          if (pPos) newY = Math.max(newY, pPos.y + MIN_CHILD_Y_GAP);
        }

        const moveDX = newX - cur.x;
        const moveDY = newY - cur.y;
        if (moveDX === 0 && moveDY === 0) return;

        // 서브트리(자신 + 모든 자손) 동반 이동 — 상대 위치 유지(평행 이동).
        const subtreeIds = d.descendants().map((n) => n.data.data.id);
        for (const id of subtreeIds) {
          const p = posRef.current.get(id);
          if (!p) continue;
          const np = { x: p.x + moveDX, y: p.y + moveDY };
          posRef.current.set(id, np);
          const hn = nodeById.get(id);
          if (hn) {
            hn.x = np.x;
            hn.y = np.y;
          }
        }

        // 이동한 노드 transform 갱신 + 링크 재계산
        const movedSet = new Set(subtreeIds);
        nodeLayer
          .selectAll<SVGGElement, HNode>("g.node")
          .filter((n) => movedSet.has(n.data.data.id))
          .attr("transform", (n) => {
            const p = posRef.current.get(n.data.data.id)!;
            return `translate(${p.x},${p.y})`;
          });
        redrawLinks();
      });

    const sel = nodeLayer
      .selectAll<SVGGElement, HNode>("g.node")
      .data(allNodes, (d) => d.data.data.id);

    sel.exit().remove();

    const enter = sel
      .enter()
      .append("g")
      .attr("class", "node")
      .style("cursor", "pointer");

    // 히트 영역
    enter.append("circle").attr("class", "hit").attr("r", R + 10).attr("fill", "transparent");
    // 활성 노드 halo
    enter.append("circle").attr("class", "halo").attr("fill", "none");
    // 코어
    enter.append("circle").attr("class", "core").attr("r", R).attr("stroke-width", 2);
    // 라벨
    enter
      .append("text")
      .attr("class", "label")
      .attr("dy", "2.3em")
      .attr("text-anchor", "middle")
      .style("font-size", "11px")
      .style("font-family", "var(--font-sans), sans-serif")
      .style("pointer-events", "none");

    const merged = enter.merge(sel);

    merged.attr("transform", (d) => `translate(${d.x},${d.y})`);

    merged.each(function (d) {
      const node = d.data.data;
      const g = d3.select(this);
      const isPath = onPath.has(node.id);
      const isActive = node.id === activeNodeId;
      const isNav = node.is_navigator;

      g.select<SVGCircleElement>("circle.core")
        .attr("fill", isNav ? C.navFill : C.nodeFill)
        .attr("stroke", isNav ? C.navStroke : isPath ? C.pathStroke : C.nodeStroke)
        .attr("stroke-width", isPath ? 3 : 2)
        .attr("stroke-dasharray", isNav ? "3 3" : null);

      g.select<SVGCircleElement>("circle.halo")
        .attr("r", R + 5)
        .attr("stroke", C.pathStroke)
        .attr("stroke-width", 1.5)
        .attr("opacity", isActive ? 0.9 : 0)
        .attr("stroke-dasharray", "2 3");

      const label = node.label ?? node.question ?? "";
      g.select<SVGTextElement>("text.label")
        .text(label.length > 12 ? label.slice(0, 12) + "…" : label)
        .attr("fill", isNav ? C.labelMuted : isPath ? C.nodeLabel : C.labelMuted)
        .style("font-weight", isPath ? 600 : 400);
    });

    merged.call(drag);

    merged.on("click", function (event, d) {
      event.stopPropagation();
      if ((d as unknown as { _moved?: boolean })._moved) return;
      onNodeClickRef.current(d.data.data.id);
    });
  }, [nodes, activeNodeId, rootNodeId, dim.width, dim.height]);

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full overflow-hidden bg-bg-elevated"
      style={{ touchAction: "none" }}
    >
      <svg ref={svgRef} className="block h-full w-full" />
      <button
        type="button"
        onClick={() => recenter(activeNodeId)}
        title="현재 노드로 이동"
        className="absolute bottom-3 right-3 rounded-lg border border-accent-border/50 bg-bg p-2 text-fg-muted shadow-sm transition-colors hover:text-fg"
      >
        <LocateFixed size={16} />
      </button>
    </div>
  );
}
