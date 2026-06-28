"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { LocateFixed, Link2, X } from "lucide-react";
import type { FileLink, NodeRow } from "@/lib/types";
import { buildNested, pathIdSet, buildById, type TreeNode } from "@/lib/tree";

/**
 * 세션 그래프 뷰 — D3 수직 트리(위→아래), 원형 노드 + 라벨 아래.
 * 줌/팬/드래그(서브트리 동반) + 현재경로 하이라이트 + 네비게이터(점선) + 기억 연결선.
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
  conn: "#c2702a", // --warning (기억 연결선 — 트리 링크와 구별)
  file: "#2a7d7a", // teal (시각적 RAG 파일 연결 — 다른 선들과 구별)
  fileFill: "#e3f1ef",
  fileBusy: "#e0a32e",
  fileFail: "#b54a3a",
} as const;

const R = 11; // 노드 반지름
const MIN_CHILD_Y_GAP = 60; // 자식이 부모 위로 올라가지 못하는 최소 수직 간격

interface Props {
  nodes: NodeRow[];
  rootNodeId: string | null;
  activeNodeId: string | null;
  onNodeClick: (id: string) => void;
  /** 기억 연결: source 노드를 현재 노드(target=activeNodeId)로 연결. */
  onConnectSource: (sourceId: string) => void;
  /** 기억 연결 해제. */
  onRemoveConnection: (targetId: string, sourceId: string) => void;
  /** 시각적 RAG: 세션의 파일↔노드 링크 목록. */
  fileLinks: FileLink[];
  /** 파일을 분기에 연결하는 모드(자료 패널에서 시작). */
  fileLinkMode: boolean;
  /** 파일 연결 모드에서 노드 클릭 시(target 노드 선택). */
  onLinkTarget: (nodeId: string) => void;
  /** 파일 연결 해제. */
  onRemoveFileLink: (fileId: string, nodeId: string) => void;
}

type HNode = d3.HierarchyPointNode<TreeNode>;
interface ConnPair {
  source: string;
  target: string;
  key: string;
}
interface FileMarker {
  key: string;
  fileId: string;
  nodeId: string;
  idx: number;
  status: string;
  name: string;
}

export default function SessionGraphCanvas({
  nodes,
  rootNodeId,
  activeNodeId,
  onNodeClick,
  onConnectSource,
  onRemoveConnection,
  fileLinks,
  fileLinkMode,
  onLinkTarget,
  onRemoveFileLink,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const contentGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const linkGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const connGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodeGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const fileGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity.translate(0, 60).scale(0.9));
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const prevRootRef = useRef<string | null>(null);

  // D3 핸들러에서 최신 값을 보기 위한 ref들
  const onNodeClickRef = useRef(onNodeClick);
  const onConnectSourceRef = useRef(onConnectSource);
  const onRemoveConnectionRef = useRef(onRemoveConnection);
  const onLinkTargetRef = useRef(onLinkTarget);
  const onRemoveFileLinkRef = useRef(onRemoveFileLink);
  const activeNodeIdRef = useRef(activeNodeId);
  const connectModeRef = useRef(false);
  const fileLinkModeRef = useRef(fileLinkMode);

  const [dim, setDim] = useState({ width: 0, height: 0 });
  const [connectMode, setConnectMode] = useState(false);

  // 연결 대상(activeNode)이 없으면 모드는 자동으로 비활성(파생값 — effect setState 회피)
  const effectiveConnectMode = connectMode && !!activeNodeId;

  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
    onConnectSourceRef.current = onConnectSource;
    onRemoveConnectionRef.current = onRemoveConnection;
    onLinkTargetRef.current = onLinkTarget;
    onRemoveFileLinkRef.current = onRemoveFileLink;
    activeNodeIdRef.current = activeNodeId;
    fileLinkModeRef.current = fileLinkMode;
  }, [
    onNodeClick,
    onConnectSource,
    onRemoveConnection,
    onLinkTarget,
    onRemoveFileLink,
    activeNodeId,
    fileLinkMode,
  ]);

  useEffect(() => {
    connectModeRef.current = effectiveConnectMode;
  }, [effectiveConnectMode]);

  // Esc로 연결 모드 취소
  useEffect(() => {
    if (!effectiveConnectMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConnectMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [effectiveConnectMode]);

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

    // 기억 연결선 화살표 마커
    const defs = svg.append("defs");
    defs
      .append("marker")
      .attr("id", "mem-arrow")
      .attr("viewBox", "0 0 10 10")
      .attr("refX", 9)
      .attr("refY", 5)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto-start-reverse")
      .append("path")
      .attr("d", "M0,0 L10,5 L0,10 z")
      .attr("fill", C.conn);

    const bg = svg
      .append("rect")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("fill", "transparent")
      .style("cursor", "grab");

    const g = svg.append("g");
    contentGRef.current = g;
    // z 순서: 트리 링크(하) → 기억 연결선 → 노드 → 파일 링크 마커(상, 클릭 가능)
    linkGRef.current = g.append("g").attr("class", "links");
    connGRef.current = g.append("g").attr("class", "connections");
    nodeGRef.current = g.append("g").attr("class", "nodes");
    fileGRef.current = g.append("g").attr("class", "filelinks");

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
    if (
      !contentGRef.current ||
      !linkGRef.current ||
      !nodeGRef.current ||
      !connGRef.current ||
      !fileGRef.current
    )
      return;
    if (dim.width === 0) return;

    // 세션(루트) 변경 시 위치 캐시 초기화
    if (prevRootRef.current !== rootNodeId) {
      posRef.current = new Map();
      prevRootRef.current = rootNodeId;
    }

    const nested = buildNested(nodes, rootNodeId);
    const linkLayer = linkGRef.current;
    const connLayer = connGRef.current;
    const nodeLayer = nodeGRef.current;
    const fileLayer = fileGRef.current;

    if (!nested) {
      linkLayer.selectAll("*").remove();
      connLayer.selectAll("*").remove();
      nodeLayer.selectAll("*").remove();
      fileLayer.selectAll("*").remove();
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

    // ── 트리 링크 ──
    linkLayer
      .selectAll<SVGPathElement, d3.HierarchyPointLink<TreeNode>>("path.link")
      .data(root.links(), (d) => d.target.data.data.id)
      .join(
        (enter) =>
          enter.append("path").attr("class", "link").attr("fill", "none"),
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
      linkLayer
        .selectAll<SVGPathElement, d3.HierarchyPointLink<TreeNode>>("path.link")
        .attr("d", linkGen);

    // ── 기억 연결선(같은 세션 내) ──
    const nodeById = new Map<string, HNode>();
    allNodes.forEach((n) => nodeById.set(n.data.data.id, n));

    const connD = (sourceId: string, targetId: string): string => {
      const s = posRef.current.get(sourceId);
      const t = posRef.current.get(targetId);
      if (!s || !t) return "";
      const my = (s.y + t.y) / 2;
      return `M${s.x},${s.y} C${s.x},${my} ${t.x},${my} ${t.x},${t.y}`;
    };

    const redrawConnections = () =>
      connLayer
        .selectAll<SVGGElement, ConnPair>("g.conn")
        .each(function (cp) {
          const path = connD(cp.source, cp.target);
          const sel = d3.select(this);
          sel.select<SVGPathElement>("path.conn-visible").attr("d", path);
          sel.select<SVGPathElement>("path.conn-hit").attr("d", path);
        });

    // ── 파일 링크 마커 좌표(노드 우상단에 적층) + 재그리기 ──
    const fileMarkerXY = (nodeId: string, idx: number) => {
      const p = posRef.current.get(nodeId);
      if (!p) return null;
      return { nx: p.x, ny: p.y, mx: p.x + 30, my: p.y - 24 - idx * 22 };
    };
    const redrawFileLinks = () =>
      fileLayer
        .selectAll<SVGGElement, FileMarker>("g.filelink")
        .each(function (fm) {
          const xy = fileMarkerXY(fm.nodeId, fm.idx);
          if (!xy) return;
          const sel = d3.select(this);
          sel
            .select<SVGLineElement>("line.file-line")
            .attr("x1", xy.nx)
            .attr("y1", xy.ny)
            .attr("x2", xy.mx)
            .attr("y2", xy.my);
          sel
            .select<SVGGElement>("g.file-marker")
            .attr("transform", `translate(${xy.mx},${xy.my})`);
        });

    // 같은 세션 그래프에 source/target 둘 다 있는 연결만 선으로
    const connPairs: ConnPair[] = [];
    for (const n of nodes) {
      for (const src of n.connections ?? []) {
        if (src !== n.id && nodeById.has(src) && nodeById.has(n.id)) {
          connPairs.push({ source: src, target: n.id, key: `${n.id}<-${src}` });
        }
      }
    }

    const connSel = connLayer
      .selectAll<SVGGElement, ConnPair>("g.conn")
      .data(connPairs, (d) => d.key);

    connSel.exit().remove();

    const connEnter = connSel
      .enter()
      .append("g")
      .attr("class", "conn")
      .style("cursor", "pointer");
    connEnter.append("title").text("클릭하면 기억 연결 해제");
    connEnter
      .append("path")
      .attr("class", "conn-visible")
      .attr("fill", "none")
      .attr("stroke", C.conn)
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "5 4")
      .attr("marker-end", "url(#mem-arrow)")
      .attr("pointer-events", "none");
    connEnter
      .append("path")
      .attr("class", "conn-hit")
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 12);

    const connMerged = connEnter.merge(connSel);
    connMerged
      .select<SVGPathElement>("path.conn-visible")
      .attr("d", (d) => connD(d.source, d.target));
    connMerged
      .select<SVGPathElement>("path.conn-hit")
      .attr("d", (d) => connD(d.source, d.target))
      .on("click", function (event, d) {
        event.stopPropagation();
        onRemoveConnectionRef.current(d.target, d.source);
      });

    // ── 드래그(서브트리 동반 이동 + y 제약) ──
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
        if (!s._moved && s._dist < 4) return;
        s._moved = true;

        const cur = posRef.current.get(d.data.data.id);
        if (!cur) return;

        const newX = cur.x + event.dx;
        let newY = cur.y + event.dy;

        if (d.parent) {
          const pPos = posRef.current.get(d.parent.data.data.id);
          if (pPos) newY = Math.max(newY, pPos.y + MIN_CHILD_Y_GAP);
        }

        const moveDX = newX - cur.x;
        const moveDY = newY - cur.y;
        if (moveDX === 0 && moveDY === 0) return;

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

        const movedSet = new Set(subtreeIds);
        nodeLayer
          .selectAll<SVGGElement, HNode>("g.node")
          .filter((n) => movedSet.has(n.data.data.id))
          .attr("transform", (n) => {
            const p = posRef.current.get(n.data.data.id)!;
            return `translate(${p.x},${p.y})`;
          });
        redrawLinks();
        redrawConnections();
        redrawFileLinks();
      });

    // ── 노드 ──
    const sel = nodeLayer
      .selectAll<SVGGElement, HNode>("g.node")
      .data(allNodes, (d) => d.data.data.id);

    sel.exit().remove();

    const enter = sel
      .enter()
      .append("g")
      .attr("class", "node")
      .style("cursor", "pointer");

    enter.append("circle").attr("class", "hit").attr("r", R + 10).attr("fill", "transparent");
    enter.append("circle").attr("class", "halo").attr("fill", "none");
    enter.append("circle").attr("class", "core").attr("r", R).attr("stroke-width", 2);
    enter
      .append("text")
      .attr("class", "label")
      .attr("dy", "2.3em")
      .attr("text-anchor", "middle")
      .style("font-size", "11px")
      .style("font-family", "var(--font-sans), sans-serif")
      .style("pointer-events", "none");
    // 다른 세션 연결 배지
    const badge = enter
      .append("g")
      .attr("class", "linkbadge")
      .style("pointer-events", "none")
      .style("display", "none");
    badge
      .append("circle")
      .attr("cx", R + 5)
      .attr("cy", -(R + 5))
      .attr("r", 7)
      .attr("fill", C.conn);
    badge
      .append("text")
      .attr("class", "linkbadge-text")
      .attr("x", R + 5)
      .attr("y", -(R + 5))
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .style("font-size", "9px")
      .style("font-weight", "700")
      .attr("fill", "#ffffff");
    enter.append("title").attr("class", "tip");

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

      const label = node.label ?? node.navigator_question ?? node.question ?? "";
      g.select<SVGTextElement>("text.label")
        .text(label.length > 12 ? label.slice(0, 12) + "…" : label)
        .attr("fill", isNav ? C.labelMuted : isPath ? C.nodeLabel : C.labelMuted)
        .style("font-weight", isPath ? 600 : 400);

      // 다른 세션 source(현재 그래프에 없는 연결) 개수 → 배지
      const crossCount = (node.connections ?? []).filter(
        (id) => !nodeById.has(id),
      ).length;
      const badgeSel = g.select<SVGGElement>("g.linkbadge");
      if (crossCount > 0) {
        badgeSel.style("display", null);
        badgeSel.select("text.linkbadge-text").text(String(crossCount));
        badgeSel.select("title").remove();
        badgeSel
          .append("title")
          .text(`다른 세션에서 가져온 기억 연결 ${crossCount}개`);
      } else {
        badgeSel.style("display", "none");
      }

      const tip = isNav
        ? `💡 ${node.navigator_question ?? ""}`
        : (node.question ?? "");
      g.select<SVGTitleElement>("title.tip").text(tip);
    });

    merged.call(drag);

    merged.on("click", function (event, d) {
      event.stopPropagation();
      if ((d as unknown as { _moved?: boolean })._moved) return;
      const node = d.data.data;
      // 파일 연결 모드(자료 패널에서 시작): 클릭 노드를 link target으로
      if (fileLinkModeRef.current) {
        if (node.is_navigator) return;
        onLinkTargetRef.current(node.id);
        return;
      }
      // 기억 연결 모드: 다른 분기의 source 노드를 현재 노드로 연결
      if (connectModeRef.current) {
        if (node.is_navigator) return;
        if (node.id === activeNodeIdRef.current) return; // self/target 제외
        onConnectSourceRef.current(node.id);
        setConnectMode(false);
        return;
      }
      onNodeClickRef.current(node.id);
    });

    // ── 파일 링크 마커(시각적 RAG) ──
    const fileMarkers: FileMarker[] = [];
    const perNode = new Map<string, number>();
    for (const fl of fileLinks) {
      if (!nodeById.has(fl.target_node_id)) continue;
      const idx = perNode.get(fl.target_node_id) ?? 0;
      perNode.set(fl.target_node_id, idx + 1);
      const f = fl.files;
      const name = f?.storage_path
        ? f.storage_path.split("/").pop() ?? f.storage_path
        : fl.file_id.slice(0, 8);
      fileMarkers.push({
        key: `${fl.file_id}->${fl.target_node_id}`,
        fileId: fl.file_id,
        nodeId: fl.target_node_id,
        idx,
        status: f?.status ?? "",
        name,
      });
    }

    const fileSel = fileLayer
      .selectAll<SVGGElement, FileMarker>("g.filelink")
      .data(fileMarkers, (d) => d.key);

    fileSel.exit().remove();

    const fileEnter = fileSel
      .enter()
      .append("g")
      .attr("class", "filelink")
      .style("cursor", "pointer");
    fileEnter
      .append("line")
      .attr("class", "file-line")
      .attr("stroke", C.file)
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "4 3")
      .attr("pointer-events", "none");
    const mk = fileEnter.append("g").attr("class", "file-marker");
    mk.append("rect")
      .attr("class", "file-box")
      .attr("x", -7)
      .attr("y", -8.5)
      .attr("width", 14)
      .attr("height", 17)
      .attr("rx", 2);
    mk.append("line").attr("class", "ft").attr("x1", -4).attr("y1", -2).attr("x2", 4).attr("y2", -2);
    mk.append("line").attr("class", "ft").attr("x1", -4).attr("y1", 1).attr("x2", 4).attr("y2", 1);
    mk.append("line").attr("class", "ft").attr("x1", -4).attr("y1", 4).attr("x2", 2).attr("y2", 4);
    fileEnter.append("title");

    const fileMerged = fileEnter.merge(fileSel);
    fileMerged.each(function (fm) {
      const sel = d3.select(this);
      const xy = fileMarkerXY(fm.nodeId, fm.idx);
      if (xy) {
        sel
          .select<SVGLineElement>("line.file-line")
          .attr("x1", xy.nx)
          .attr("y1", xy.ny)
          .attr("x2", xy.mx)
          .attr("y2", xy.my);
        sel
          .select<SVGGElement>("g.file-marker")
          .attr("transform", `translate(${xy.mx},${xy.my})`);
      }
      const busy = !!fm.status && fm.status !== "indexed";
      const fail = fm.status === "failed" || fm.status === "partial";
      const stroke = fail ? C.fileFail : busy ? C.fileBusy : C.file;
      sel
        .select<SVGRectElement>("rect.file-box")
        .attr("fill", C.fileFill)
        .attr("stroke", stroke)
        .attr("stroke-width", 1.5);
      sel
        .selectAll<SVGLineElement, unknown>("line.ft")
        .attr("stroke", stroke)
        .attr("stroke-width", 1);
      sel
        .select("title")
        .text(
          `📎 ${fm.name}${busy ? " (임베딩 중)" : ""} — 클릭하면 연결 해제`,
        );
    });
    fileMerged.on("click", function (event, fm) {
      event.stopPropagation();
      onRemoveFileLinkRef.current(fm.fileId, fm.nodeId);
    });
  }, [nodes, activeNodeId, rootNodeId, dim.width, dim.height, fileLinks]);

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full overflow-hidden bg-bg-elevated"
      style={{ touchAction: "none" }}
    >
      <svg ref={svgRef} className="block h-full w-full" />

      {/* 기억 연결 모드 토글 */}
      <button
        type="button"
        onClick={() => setConnectMode((v) => !v)}
        disabled={!activeNodeId || fileLinkMode}
        title={
          activeNodeId
            ? "기억 연결: 다른 분기의 노드를 현재 노드로 연결"
            : "연결할 현재 노드를 먼저 선택하세요"
        }
        className={`absolute left-3 top-3 flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium shadow-sm transition-colors disabled:opacity-50 ${
          effectiveConnectMode
            ? "border-warning bg-warning text-white"
            : "border-accent-border/50 bg-bg text-fg-muted hover:text-fg"
        }`}
      >
        <Link2 size={14} />
        기억 연결
      </button>

      {/* 기억 연결 모드 안내 배너 */}
      {effectiveConnectMode && !fileLinkMode && (
        <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-warning/60 bg-bg px-3 py-1.5 text-xs text-warning shadow">
          다른 분기의 노드를 클릭해 현재 노드로 기억을 연결하세요.
          <button
            type="button"
            onClick={() => setConnectMode(false)}
            className="flex items-center gap-0.5 text-fg-muted hover:text-fg"
          >
            <X size={12} />취소
          </button>
        </div>
      )}

      {/* 파일 연결 모드 안내 배너 (자료 패널에서 시작) */}
      {fileLinkMode && (
        <div
          className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow"
          style={{ borderColor: C.file, color: C.file, background: "var(--bg)" }}
        >
          📎 자료를 연결할 분기 노드를 클릭하세요.
        </div>
      )}

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
