"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { LocateFixed, LayoutGrid, GitFork, Layers, Upload } from "lucide-react";
import type { FileLink, FileRow, NodeRow } from "@/lib/types";
import { buildNested, pathIdSet, buildById, type TreeNode } from "@/lib/tree";

/**
 * 세션 그래프 뷰 — D3 수직 트리(위→아래) + Wave A 인터랙션(§10, D13~D20).
 * - 대화 노드(원형) + 파일 노드(문서) 레이어, 줌/팬/드래그(서브트리 동반).
 * - 우클릭 컨텍스트 메뉴: 이동 / 기억 연결(마우스 추적 점선) / 브랜치 참조.
 * - 좌표 영속(저장 좌표 우선) + "노드 재정렬" 버튼, OS 파일 드래그&드롭 업로드.
 */

const C = {
  nodeFill: "#fcf58b",
  nodeStroke: "#6b4e13",
  nodeLabel: "#3a3320",
  pathStroke: "#e0a32e",
  linkNormal: "#d9cfb0",
  linkPath: "#e0a32e",
  navStroke: "#7a7a6e",
  navFill: "#fffdf7",
  labelMuted: "#7a7a6e",
  conn: "#c2702a", // 기억 연결선(주황)
  file: "#2a7d7a", // 파일 연결선/노드(청록)
  fileFill: "#e3f1ef",
  fileBusy: "#e0a32e",
  fileFail: "#b54a3a",
} as const;

const TRACK_COLORS = ["#e0a32e", "#6e8a3c", "#c2702a", "#3a7d9a", "#9a5ea3"];

const R = 11;
const MIN_CHILD_Y_GAP = 60;

interface ConnPair {
  source: string;
  target: string;
  key: string;
}

interface Props {
  nodes: NodeRow[];
  rootNodeId: string | null;
  activeNodeId: string | null;
  onNodeClick: (id: string) => void;
  /** 기억 연결(D14): source=우클릭 노드, target=클릭 노드. */
  onConnectNodes: (sourceId: string, targetId: string) => void;
  onRemoveConnection: (targetId: string, sourceId: string) => void;
  /** 시각적 RAG(3b-2 유지): 자료 패널에서 시작한 파일→분기 연결 모드. */
  fileLinks: FileLink[];
  fileNodes: FileRow[];
  /** 파일 노드 태그(툴팁용). fileId → 태그 이름들. */
  fileTags: Record<string, string[]>;
  fileLinkMode: boolean;
  onLinkTarget: (nodeId: string) => void;
  onRemoveFileLink: (fileId: string, nodeId: string) => void;
  /** 파일 노드 좌표 영속(D13/D20). */
  onFilePosition: (fileId: string, x: number, y: number) => void;
  /** OS 파일 드롭 업로드(D16). 좌표는 그래프 좌표. */
  onDropUpload: (files: File[], x: number, y: number) => void;
  /** 노드 좌표 일괄 영속(D20). */
  onPersistPositions: (
    positions: { node_id: string; x: number; y: number }[],
  ) => void;
  /** 브랜치 참조(D15). */
  trackMode: boolean;
  selectedTrackIds: string[];
  onToggleTrack: (nodeId: string) => void;
  onEnterTrack: (nodeId: string) => void;
}

type HNode = d3.HierarchyPointNode<TreeNode>;
type Pt = { x: number; y: number };

export default function SessionGraphCanvas(props: Props) {
  const {
    nodes,
    rootNodeId,
    activeNodeId,
    fileLinks,
    fileNodes,
    fileTags,
    fileLinkMode,
    trackMode,
    selectedTrackIds,
  } = props;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const linkGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const connGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const fileGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodeGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const tempGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity.translate(0, 60).scale(0.9));

  const posRef = useRef<Map<string, Pt>>(new Map()); // 대화 노드
  const filePosRef = useRef<Map<string, Pt>>(new Map()); // 파일 노드
  const prevRootRef = useRef<string | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceLayoutRef = useRef(false);

  // 최신 props를 D3 핸들러에서 보기 위한 ref (이벤트 시점에 최신값 참조)
  const pr = useRef(props);
  useEffect(() => {
    pr.current = props;
  });

  const [dim, setDim] = useState({ width: 0, height: 0 });
  const [reorderNonce, setReorderNonce] = useState(0);
  const [connectingSourceId, setConnectingSourceId] = useState<string | null>(null);
  const connectingRef = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    connectingRef.current = connectingSourceId;
  }, [connectingSourceId]);

  // ── 컨테이너 크기 ──
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

  // client → graph 좌표 변환
  const toGraph = (clientX: number, clientY: number): Pt => {
    const rect = svgRef.current?.getBoundingClientRect();
    const t = transformRef.current;
    const lx = clientX - (rect?.left ?? 0);
    const ly = clientY - (rect?.top ?? 0);
    return { x: (lx - t.x) / t.k, y: (ly - t.y) / t.k };
  };

  // ── SVG/레이어/줌 1회 초기화 ──
  useEffect(() => {
    if (!svgRef.current || dim.width === 0 || gRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const bg = svg
      .append("rect")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("fill", "transparent")
      .style("cursor", "grab");
    bg.on("click", () => {
      if (connectingRef.current) setConnectingSourceId(null);
      setMenu(null);
    });

    const g = svg.append("g");
    gRef.current = g;
    linkGRef.current = g.append("g").attr("class", "links");
    connGRef.current = g.append("g").attr("class", "connections");
    fileGRef.current = g.append("g").attr("class", "filenodes");
    nodeGRef.current = g.append("g").attr("class", "nodes");
    tempGRef.current = g.append("g").attr("class", "temp");

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
    d3.select(svgRef.current).transition().duration(500).call(zoomRef.current.transform, t);
  };

  // 유효 연결 타깃: 조상/자손/자기자신 거부
  const isValidConnectTarget = (
    sourceId: string,
    targetId: string,
    byId: Map<string, NodeRow>,
  ): boolean => {
    if (sourceId === targetId) return false;
    const aSrc = pathIdSet(sourceId, byId);
    const aTgt = pathIdSet(targetId, byId);
    return !aSrc.has(targetId) && !aTgt.has(sourceId);
  };

  const debouncedPersist = (
    positions: { node_id: string; x: number; y: number }[],
  ) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      pr.current.onPersistPositions(positions);
    }, 400);
  };

  // ── 메인 데이터 렌더링 ──
  useEffect(() => {
    if (
      !gRef.current ||
      !linkGRef.current ||
      !nodeGRef.current ||
      !connGRef.current ||
      !fileGRef.current
    )
      return;
    if (dim.width === 0) return;

    if (prevRootRef.current !== rootNodeId) {
      posRef.current = new Map();
      filePosRef.current = new Map();
      prevRootRef.current = rootNodeId;
    }

    const linkLayer = linkGRef.current;
    const connLayer = connGRef.current;
    const fileLayer = fileGRef.current;
    const nodeLayer = nodeGRef.current;

    const nested = buildNested(nodes, rootNodeId);
    if (!nested) {
      linkLayer.selectAll("*").remove();
      connLayer.selectAll("*").remove();
      fileLayer.selectAll("*").remove();
      nodeLayer.selectAll("*").remove();
      return;
    }

    const byId = buildById(nodes);
    const onPath = pathIdSet(activeNodeId, byId);
    const forceLayout = forceLayoutRef.current;

    const layout = d3.tree<TreeNode>().nodeSize([74, 120]);
    const root = layout(d3.hierarchy(nested, (d) => d.children));
    const allNodes = root.descendants();

    // 좌표 해석: 재정렬 강제 시 레이아웃, 아니면 (드래그 캐시 → 저장 좌표 → 레이아웃)
    allNodes.forEach((d) => {
      const node = d.data.data;
      if (forceLayout) {
        posRef.current.set(node.id, { x: d.x, y: d.y });
        return;
      }
      const cached = posRef.current.get(node.id);
      if (cached) {
        d.x = cached.x;
        d.y = cached.y;
      } else if (node.position_x != null && node.position_y != null) {
        d.x = node.position_x;
        d.y = node.position_y;
        posRef.current.set(node.id, { x: d.x, y: d.y });
      } else {
        posRef.current.set(node.id, { x: d.x, y: d.y });
      }
    });

    const nodeById = new Map<string, HNode>();
    allNodes.forEach((n) => nodeById.set(n.data.data.id, n));

    if (forceLayout) {
      forceLayoutRef.current = false;
      pr.current.onPersistPositions(
        allNodes.map((d) => ({ node_id: d.data.data.id, x: d.x, y: d.y })),
      );
    }

    // 파일 노드 좌표(저장 좌표 우선, 없으면 current_head 근처)
    const headPos = activeNodeId ? posRef.current.get(activeNodeId) : null;
    fileNodes.forEach((f, i) => {
      if (filePosRef.current.has(f.id)) return;
      if (f.position_x != null && f.position_y != null) {
        filePosRef.current.set(f.id, { x: f.position_x, y: f.position_y });
      } else {
        const base = headPos ?? { x: 0, y: 60 };
        filePosRef.current.set(f.id, {
          x: base.x + 90 + (i % 3) * 46,
          y: base.y + 40 + Math.floor(i / 3) * 46,
        });
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
        (enter) => enter.append("path").attr("class", "link").attr("fill", "none"),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr("stroke", (d) =>
        onPath.has(d.target.data.data.id) ? C.linkPath : C.linkNormal,
      )
      .attr("stroke-width", (d) => (onPath.has(d.target.data.data.id) ? 2.5 : 1.5))
      .attr("d", linkGen);

    const redrawLinks = () =>
      linkLayer
        .selectAll<SVGPathElement, d3.HierarchyPointLink<TreeNode>>("path.link")
        .attr("d", linkGen);

    // ── 기억 연결선 ──
    const connD = (sourceId: string, targetId: string): string => {
      const s = posRef.current.get(sourceId);
      const t = posRef.current.get(targetId);
      if (!s || !t) return "";
      const my = (s.y + t.y) / 2;
      return `M${s.x},${s.y} C${s.x},${my} ${t.x},${my} ${t.x},${t.y}`;
    };
    const redrawConnections = () =>
      connLayer.selectAll<SVGGElement, ConnPair>("g.conn").each(function (cp) {
        const path = connD(cp.source, cp.target);
        const sel = d3.select(this);
        sel.select<SVGPathElement>("path.conn-visible").attr("d", path);
        sel.select<SVGPathElement>("path.conn-hit").attr("d", path);
      });

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
        pr.current.onRemoveConnection(d.target, d.source);
      });

    // ── 파일 연결선(파일 노드 ↔ target 분기 노드) ──
    const fileLinkD = (fileId: string, nodeId: string): string => {
      const f = filePosRef.current.get(fileId);
      const t = posRef.current.get(nodeId);
      if (!f || !t) return "";
      const my = (f.y + t.y) / 2;
      return `M${f.x},${f.y} C${f.x},${my} ${t.x},${my} ${t.x},${t.y}`;
    };
    const visibleLinks = fileLinks.filter(
      (l) => nodeById.has(l.target_node_id) && filePosRef.current.has(l.file_id),
    );
    const redrawFileLines = () =>
      connLayer.selectAll<SVGGElement, FileLink>("g.fileconn").each(function (l) {
        const path = fileLinkD(l.file_id, l.target_node_id);
        const sel = d3.select(this);
        sel.select<SVGPathElement>("path.fl-vis").attr("d", path);
        sel.select<SVGPathElement>("path.fl-hit").attr("d", path);
      });
    const flSel = connLayer
      .selectAll<SVGGElement, FileLink>("g.fileconn")
      .data(visibleLinks, (d) => `${d.file_id}->${d.target_node_id}`);
    flSel.exit().remove();
    const flEnter = flSel
      .enter()
      .append("g")
      .attr("class", "fileconn")
      .style("cursor", "pointer");
    flEnter.append("title").text("클릭하면 자료 연결 해제");
    flEnter
      .append("path")
      .attr("class", "fl-vis")
      .attr("fill", "none")
      .attr("stroke", C.file)
      .attr("stroke-width", 1.6)
      .attr("stroke-dasharray", "4 3")
      .attr("pointer-events", "none");
    flEnter
      .append("path")
      .attr("class", "fl-hit")
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 12);
    const flMerged = flEnter.merge(flSel);
    flMerged.select<SVGPathElement>("path.fl-vis").attr("d", (l) =>
      fileLinkD(l.file_id, l.target_node_id),
    );
    flMerged
      .select<SVGPathElement>("path.fl-hit")
      .attr("d", (l) => fileLinkD(l.file_id, l.target_node_id))
      .on("click", function (event, l) {
        event.stopPropagation();
        pr.current.onRemoveFileLink(l.file_id, l.target_node_id);
      });

    // ── 드래그(대화 노드, 서브트리 동반 + y 제약 + 좌표 영속) ──
    const drag = d3
      .drag<SVGGElement, HNode>()
      .filter((event) => (event as MouseEvent).button === 0 && !connectingRef.current)
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
        const dX = newX - cur.x;
        const dY = newY - cur.y;
        if (dX === 0 && dY === 0) return;
        const subtreeIds = d.descendants().map((n) => n.data.data.id);
        for (const id of subtreeIds) {
          const p = posRef.current.get(id);
          if (!p) continue;
          const np = { x: p.x + dX, y: p.y + dY };
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
        redrawFileLines();
      })
      .on("end", function (_event, d) {
        const s = d as unknown as { _moved?: boolean };
        if (!s._moved) return;
        const subtreeIds = d.descendants().map((n) => n.data.data.id);
        debouncedPersist(
          subtreeIds
            .map((id) => {
              const p = posRef.current.get(id);
              return p ? { node_id: id, x: p.x, y: p.y } : null;
            })
            .filter((v): v is { node_id: string; x: number; y: number } => !!v),
        );
      });

    // ── 대화 노드 ──
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
    const tbadge = enter.append("g").attr("class", "trackbadge").style("display", "none");
    tbadge.append("circle").attr("cx", R + 5).attr("cy", -(R + 5)).attr("r", 8);
    tbadge
      .append("text")
      .attr("class", "tb-text")
      .attr("x", R + 5)
      .attr("y", -(R + 5))
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .style("font-size", "10px")
      .style("font-weight", "700")
      .attr("fill", "#fff");
    enter.append("title").attr("class", "tip");

    const merged = enter.merge(sel);
    merged.attr("transform", (d) => `translate(${d.x},${d.y})`);

    const effectiveTracks = trackMode
      ? Array.from(
          new Set(
            [activeNodeId, ...selectedTrackIds].filter(Boolean) as string[],
          ),
        )
      : [];

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

      const tIdx = effectiveTracks.indexOf(node.id);
      const tb = g.select<SVGGElement>("g.trackbadge");
      if (tIdx !== -1) {
        tb.style("display", null);
        tb.select("circle").attr("fill", TRACK_COLORS[tIdx % TRACK_COLORS.length]);
        tb.select("text.tb-text").text(String.fromCharCode(65 + tIdx));
      } else {
        tb.style("display", "none");
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
      const P = pr.current;
      if (connectingRef.current) {
        const src = connectingRef.current;
        if (!node.is_navigator && isValidConnectTarget(src, node.id, byId)) {
          P.onConnectNodes(src, node.id);
        }
        setConnectingSourceId(null);
        return;
      }
      if (P.fileLinkMode) {
        if (!node.is_navigator) P.onLinkTarget(node.id);
        return;
      }
      if (P.trackMode) {
        if (node.id === P.activeNodeId) return;
        const isLeaf = !nodes.some(
          (c) => c.parent_id === node.id && !c.is_navigator,
        );
        if (isLeaf && !node.is_navigator) P.onToggleTrack(node.id);
        return;
      }
      P.onNodeClick(node.id);
    });

    merged.on("contextmenu", function (event, d) {
      event.preventDefault();
      event.stopPropagation();
      const rect = wrapperRef.current?.getBoundingClientRect();
      setMenu({
        x: (event as MouseEvent).clientX - (rect?.left ?? 0),
        y: (event as MouseEvent).clientY - (rect?.top ?? 0),
        nodeId: d.data.data.id,
      });
    });

    // ── 파일 노드(문서) ──
    const fileDrag = d3
      .drag<SVGGElement, FileRow>()
      .on("start", function (event) {
        event.sourceEvent.stopPropagation();
        d3.select(this).raise();
      })
      .on("drag", function (event, f) {
        const p = filePosRef.current.get(f.id);
        if (!p) return;
        const np = { x: p.x + event.dx, y: p.y + event.dy };
        filePosRef.current.set(f.id, np);
        d3.select(this).attr("transform", `translate(${np.x},${np.y})`);
        redrawFileLines();
      })
      .on("end", function (_event, f) {
        const p = filePosRef.current.get(f.id);
        if (p) pr.current.onFilePosition(f.id, p.x, p.y);
      });

    const fsel = fileLayer
      .selectAll<SVGGElement, FileRow>("g.filenode")
      .data(fileNodes, (d) => d.id);
    fsel.exit().remove();
    const fenter = fsel
      .enter()
      .append("g")
      .attr("class", "filenode")
      .style("cursor", "grab");
    fenter
      .append("rect")
      .attr("class", "fbox")
      .attr("x", -10)
      .attr("y", -12)
      .attr("width", 20)
      .attr("height", 24)
      .attr("rx", 3);
    fenter.append("line").attr("class", "fl").attr("x1", -5).attr("y1", -5).attr("x2", 5).attr("y2", -5);
    fenter.append("line").attr("class", "fl").attr("x1", -5).attr("y1", 0).attr("x2", 5).attr("y2", 0);
    fenter.append("line").attr("class", "fl").attr("x1", -5).attr("y1", 5).attr("x2", 2).attr("y2", 5);
    fenter
      .append("text")
      .attr("class", "fname")
      .attr("dy", "2.4em")
      .attr("text-anchor", "middle")
      .style("font-size", "9px")
      .style("font-family", "var(--font-sans), sans-serif")
      .style("pointer-events", "none")
      .attr("fill", C.file);
    fenter.append("title");

    const fmerged = fenter.merge(fsel);
    fmerged.each(function (f) {
      const p = filePosRef.current.get(f.id);
      const s2 = d3.select(this);
      if (p) s2.attr("transform", `translate(${p.x},${p.y})`);
      const busy = f.status !== "indexed";
      const fail = f.status === "failed" || f.status === "partial";
      const stroke = fail ? C.fileFail : busy ? C.fileBusy : C.file;
      s2.select("rect.fbox").attr("fill", C.fileFill).attr("stroke", stroke).attr("stroke-width", 1.5);
      s2.selectAll("line.fl").attr("stroke", stroke).attr("stroke-width", 1);
      const nm =
        f.name ||
        f.filename ||
        (f.storage_path
          ? f.storage_path.split("/").pop() || f.storage_path
          : f.id.slice(0, 6));
      s2.select("text.fname").text(nm.length > 10 ? nm.slice(0, 10) + "…" : nm);
      const tg = fileTags[f.id];
      const tagLine = tg && tg.length > 0 ? `\n태그: ${tg.slice(0, 8).map((t) => "#" + t).join(" ")}` : "";
      s2.select("title").text(`📎 ${nm}${busy ? " (임베딩 중)" : ""}${tagLine}`);
    });
    fmerged.call(fileDrag);

    redrawFileLines();
  }, [
    nodes,
    activeNodeId,
    rootNodeId,
    dim.width,
    dim.height,
    fileLinks,
    fileNodes,
    fileTags,
    trackMode,
    selectedTrackIds,
    reorderNonce,
  ]);

  // ── 마우스 추적 연결선(D14) ──
  useEffect(() => {
    const layer = tempGRef.current;
    if (!layer) return;
    if (!connectingSourceId) {
      layer.selectAll("*").remove();
      return;
    }
    const src = posRef.current.get(connectingSourceId);
    if (!src) return;
    layer.selectAll("*").remove();
    const path = layer
      .append("path")
      .attr("fill", "none")
      .attr("stroke", C.conn)
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "5 4")
      .attr("pointer-events", "none");
    const onMove = (e: MouseEvent) => {
      const p = toGraph(e.clientX, e.clientY);
      const my = (src.y + p.y) / 2;
      path.attr("d", `M${src.x},${src.y} C${src.x},${my} ${p.x},${my} ${p.x},${p.y}`);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      layer.selectAll("*").remove();
    };
  }, [connectingSourceId]);

  // Esc로 모드 취소
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConnectingSourceId(null);
        setMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleReorder = () => {
    forceLayoutRef.current = true;
    posRef.current = new Map();
    setReorderNonce((n) => n + 1);
  };

  // ── 드래그&드롭 업로드(D16) ──
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      if (!dropActive) setDropActive(true);
    }
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDropActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const p = toGraph(e.clientX, e.clientY);
    pr.current.onDropUpload(files, p.x, p.y);
  };

  const menuNode = menu ? nodes.find((n) => n.id === menu.nodeId) : null;

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full overflow-hidden bg-bg-elevated"
      style={{ touchAction: "none" }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <svg ref={svgRef} className="block h-full w-full" />

      {dropActive && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-[#2a7d7a] bg-[#2a7d7a]/10 text-sm font-medium text-[#2a7d7a]">
          <Upload size={16} className="mr-1.5" /> 파일을 놓으면 자료로 업로드됩니다
        </div>
      )}

      {connectingSourceId && (
        <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-warning/60 bg-bg px-3 py-1.5 text-xs text-warning shadow">
          기억 연결: 다른 분기의 노드를 클릭하세요. (배경 클릭·Esc=취소)
        </div>
      )}
      {trackMode && !connectingSourceId && (
        <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-accent-deep/60 bg-bg px-3 py-1.5 text-xs text-accent-deep shadow">
          브랜치 참조: 비교할 leaf 노드를 클릭해 선택하세요.
        </div>
      )}
      {fileLinkMode && !connectingSourceId && !trackMode && (
        <div
          className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs shadow"
          style={{ borderColor: C.file, color: C.file, background: "var(--bg)" }}
        >
          📎 자료를 연결할 분기 노드를 클릭하세요.
        </div>
      )}

      <div className="absolute bottom-3 right-3 flex gap-1.5">
        <button
          type="button"
          onClick={handleReorder}
          title="노드 재정렬 (자동 레이아웃 재계산)"
          className="rounded-lg border border-accent-border/50 bg-bg p-2 text-fg-muted shadow-sm transition-colors hover:text-fg"
        >
          <LayoutGrid size={16} />
        </button>
        <button
          type="button"
          onClick={() => recenter(activeNodeId)}
          title="현재 노드로 이동"
          className="rounded-lg border border-accent-border/50 bg-bg p-2 text-fg-muted shadow-sm transition-colors hover:text-fg"
        >
          <LocateFixed size={16} />
        </button>
      </div>

      {menu && menuNode && !menuNode.is_navigator && (
        <div
          className="absolute z-30 w-48 overflow-hidden rounded-lg border border-accent-border/50 bg-bg-elevated py-1 text-sm shadow-lg"
          style={{ left: Math.min(menu.x, (dim.width || 9999) - 200), top: menu.y }}
          onMouseLeave={() => setMenu(null)}
        >
          <button
            type="button"
            onClick={() => {
              pr.current.onNodeClick(menu.nodeId);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-accent/30"
          >
            <LocateFixed size={13} /> 이 노드로 이동
          </button>
          <button
            type="button"
            onClick={() => {
              setConnectingSourceId(menu.nodeId);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-accent/30"
          >
            <GitFork size={13} /> 기억 연결
          </button>
          <button
            type="button"
            onClick={() => {
              pr.current.onEnterTrack(menu.nodeId);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-accent/30"
          >
            <Layers size={13} /> 브랜치 참조에 추가
          </button>
        </div>
      )}
    </div>
  );
}
