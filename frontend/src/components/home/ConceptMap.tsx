"use client";

/**
 * 개념 지도 (D189) — 지금까지 대화한 개념 전부를 한 장에.
 *
 * 캔버스의 지도(D151 Minimap)가 **세션 하나**를 보여 준다면 이쪽은 **전부**다.
 * 홈이 "언제 대화했는지"만 말하던 것을 "내가 무엇을 아는가"로 바꾼다.
 *
 * ## 왜 캔버스인가
 *
 * Minimap은 SVG다 — 노드 수십 개에는 그게 맞다(요소마다 이벤트·CSS가 붙는다).
 * 여기는 카드 1,200장에 선 수천 개라 DOM 요소가 그만큼 생기면 힘 배치가 매
 * 틱마다 그 전부를 건드린다. 캔버스는 한 장에 그린다.
 *
 * ## 자리는 의미가, 이름은 분류가 정한다
 *
 * 좌표는 서버가 주지 않는다(화면 크기마다 달라야 한다). 서버가 주는 것은
 * **비슷한 것끼리의 선**이고, 힘 배치가 그 선을 당겨 뭉치게 한다. 무리 이름은
 * 분류 태그를 쓴다 — 그래프에서 무리를 찾아내면 이름을 못 붙이는데, 학생에게
 * "무리 3"은 아무 뜻도 없다.
 *
 * ## 같은 지도여야 한다
 *
 * 시작 자리를 id에서 뽑는다(`seedPositions`). d3에 맡기면 배열 순서로 뿌려서
 * **카드 하나가 늘 때마다 지도 전체가 다시 배치된다** — 어제 왼쪽 위에 있던
 * 무리가 오늘 오른쪽에 있으면 그건 지도가 아니라 매번 새 그림이다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  select,
  zoom as d3zoom,
  zoomIdentity,
  type D3ZoomEvent,
  type Simulation,
} from "d3";
import type { ConceptMapData, ConceptNode } from "@/lib/api/conceptMap";
import {
  boundsOf,
  clusterLabels,
  degrees,
  pickSpacedLabels,
  seedPositions,
  tagHue,
  tierFor,
  type PlacedNode,
} from "@/lib/home/conceptLayout";

/** 힘 배치가 쓰는 노드 — d3가 x/y/vx/vy를 여기에 직접 쓴다. */
interface SimNode extends PlacedNode {
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimEdge {
  source: SimNode | string;
  target: SimNode | string;
  distance: number;
}

export interface ConceptMapProps {
  data: ConceptMapData;
  /** 노드를 눌렀다 — 그 대화의 그 카드로 간다. */
  onOpen: (node: ConceptNode) => void;
}

/** 시작 자리를 뿌릴 원판의 반지름. 화면과 무관한 월드 단위다. */
const SEED_RADIUS = 900;

/** 선을 그리는 최소 배율. 축소 상태에서 선까지 그리면 회색 판이 된다. */
const EDGE_MIN_ZOOM = 0.35;

/** 툴팁 크기. 화면 밖으로 나가지 않게 접는 계산이 이 값을 쓴다. */
const TIP_W = 260;
const TIP_H = 110;

/**
 * 캔버스 글꼴.
 *
 * ⚠️ **`var(--font-ui)`를 쓰면 안 된다.** 캔버스의 `ctx.font`는 CSS 변수를
 * 모른다 — 문자열이 통째로 무효가 되어 **지정이 무시되고** 기본값(10px
 * sans-serif)이 남는다. 그 10px는 월드 단위라 확대하면 같이 커진다: 6배에서
 * 60px짜리 글자가 화면을 덮었다(실측 2026-08-06). 조용히 틀리는 종류다 —
 * 예외도 경고도 없고 글자는 그려지므로, 확대해 보기 전에는 멀쩡해 보인다.
 */
const CANVAS_FONT = `system-ui, -apple-system, "Segoe UI", sans-serif`;

/** 제목에 쓰는 최대 글자 수. 길면 옆 개념을 덮는다. */
const LABEL_MAX_CHARS = 18;

/** 제목 한 줄 높이(화면 px) — 겹침 판정의 세로 크기다. */
const LABEL_LINE = 14;

export function ConceptMap({ data, onOpen }: ConceptMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);
  /** 화면 변환. React state로 두면 팬/줌마다 전체가 다시 돈다(D124와 같은 이유). */
  const viewRef = useRef({ k: 0.5, x: 0, y: 0 });
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const hoverRef = useRef<SimNode | null>(null);
  const drawRef = useRef<() => void>(() => {});

  /** hover한 개념 — 이것만 React가 안다(툴팁 하나 그리는 값이다). */
  const [hover, setHover] = useState<{ node: ConceptNode; sx: number; sy: number } | null>(
    null,
  );

  const sessionById = useMemo(
    () => new Map(data.sessions.map((s) => [s.id, s])),
    [data.sessions],
  );

  /**
   * 힘 배치 + 그리기.
   *
   * 데이터가 바뀔 때만 다시 세운다. 안에서 React state를 건드리지 않는다 —
   * 틱마다 setState하면 1,200개가 매 프레임 다시 렌더된다.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const deg = degrees(data.nodes, data.edges);
    const nodes: SimNode[] = seedPositions(data.nodes, SEED_RADIUS).map((n) => ({
      ...n,
      degree: deg.get(n.id) ?? 0,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges: SimEdge[] = data.edges
      .filter((e) => byId.has(e.a) && byId.has(e.b))
      .map((e) => ({ source: e.a, target: e.b, distance: e.distance }));
    nodesRef.current = nodes;
    edgesRef.current = edges;

    // 색은 테마 토큰에서 읽는다 — 캔버스는 CSS 변수를 직접 못 쓴다.
    const css = getComputedStyle(document.documentElement);
    const tone = (name: string, fallback: string) =>
      css.getPropertyValue(name).trim() || fallback;
    const inkColor = tone("--fg", "#221e17");
    const mutedColor = tone("--fg-muted", "#6a6153");
    const paperColor = tone("--bg-elevated", "#fffefa");

    let width = 0;
    let height = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = wrap.getBoundingClientRect();
      width = r.width;
      height = r.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };

    /**
     * 점의 **화면상** 크기. 선이 많은 개념이 크다 — 여러 대화에 걸친 개념이
     * 지도의 이정표가 된다.
     *
     * 힘 배치(충돌 반경)는 월드 단위를 원하고 그리기는 화면 단위를 원한다.
     * 둘을 같은 값으로 쓰면 **확대할수록 점이 부풀어** 화면이 색 덩어리가 된다
     * (실측 2026-08-06). 지도의 점은 확대해도 같은 크기다 — 도시 점이 커지지
     * 않는 것과 같다.
     */
    function nodeScreenRadius(n: SimNode): number {
      return 3 + Math.min(7, Math.sqrt(n.degree) * 1.7);
    }

    function draw() {
      const { k, x: tx, y: ty } = viewRef.current;
      const tier = tierFor(k);
      ctx!.save();
      ctx!.setTransform(
        window.devicePixelRatio || 1,
        0,
        0,
        window.devicePixelRatio || 1,
        0,
        0,
      );
      ctx!.clearRect(0, 0, width, height);
      ctx!.translate(tx, ty);
      ctx!.scale(k, k);

      // --- 선 -----------------------------------------------------------
      if (k >= EDGE_MIN_ZOOM) {
        ctx!.lineWidth = 1 / k;
        for (const e of edgesRef.current) {
          const s = e.source as SimNode;
          const t = e.target as SimNode;
          if (!s || !t) continue;
          // 가까운 쌍일수록 진하게. 먼 쌍까지 같은 농도로 그으면 구조가 묻힌다.
          const strength = Math.max(0, 1 - e.distance / 0.7);
          ctx!.strokeStyle = `rgba(160,101,3,${0.06 + strength * 0.22})`;
          ctx!.beginPath();
          ctx!.moveTo(s.x, s.y);
          ctx!.lineTo(t.x, t.y);
          ctx!.stroke();
        }
      }

      // --- 노드 ---------------------------------------------------------
      const hovered = hoverRef.current;
      for (const n of nodesRef.current) {
        // 화면 크기를 배율로 나눠 월드 단위로 — 결과가 확대와 무관하게 일정하다.
        const r = nodeScreenRadius(n) / k;
        const hue = tagHue(n.tag);
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx!.fillStyle = n.tag
          ? `hsl(${hue} 62% 52%)`
          : `hsl(40 6% 62%)`;
        ctx!.globalAlpha = tier === "clusters" ? 0.75 : 1;
        ctx!.fill();
        if (n === hovered) {
          ctx!.globalAlpha = 1;
          ctx!.lineWidth = 2 / k;
          ctx!.strokeStyle = inkColor;
          ctx!.stroke();
        }
        ctx!.globalAlpha = 1;
      }

      // --- 글자 ---------------------------------------------------------
      if (tier === "titles") {
        ctx!.font = `${12 / k}px ${CANVAS_FONT}`;
        ctx!.textAlign = "center";
        ctx!.textBaseline = "top";
        ctx!.lineWidth = 3 / k;
        ctx!.strokeStyle = paperColor;
        ctx!.fillStyle = inkColor;
        /**
         * **겹치는 제목은 그리지 않는다.**
         *
         * 전부 그리면 글자가 서로를 덮어 한 글자도 못 읽는다(실측: 확대 화면이
         * 검은 글자 벽이 됐다). 화면을 격자로 나눠 칸마다 하나만 쓴다 — 어느
         * 것을 살릴지는 선이 많은 순서다(이정표가 되는 개념이 이름을 갖는다).
         */
        const named = nodesRef.current.filter((n) => n.title || n.preview);
        // 선이 많은 개념이 먼저 자리를 잡는다 — 이정표가 이름을 갖는다.
        named.sort((a, b) => b.degree - a.degree);
        for (const n of pickSpacedLabels(named, (v) => {
          // 폭은 **재서** 쓴다. 어림치로 두면 긴 이름이 옆 것을 덮는다.
          const t = (v.title || v.preview).slice(0, LABEL_MAX_CHARS);
          return {
            x: v.x * k + tx,
            y: v.y * k + ty,
            w: ctx!.measureText(t).width * k,
            h: LABEL_LINE,
          };
        })) {
          const label = (n.title || n.preview).slice(0, LABEL_MAX_CHARS);
          const y = n.y + nodeScreenRadius(n) / k + 3 / k;
          ctx!.strokeText(label, n.x, y);
          ctx!.fillText(label, n.x, y);
        }
      } else {
        // 무리 이름 — 축소했을 때 지도가 무엇에 대한 것인지 말해 준다.
        // 무리 이름도 겹치면 못 읽는다 — 실측: 중심에 넷이 쌓여 뭉개졌다.
        // `clusterLabels`가 큰 무리부터 주므로 큰 것이 자리를 잡는다.
        ctx!.textAlign = "center";
        ctx!.textBaseline = "middle";
        const clusterSize = (count: number) =>
          Math.min(30, 12 + Math.sqrt(count) * 2.4);
        const labels = pickSpacedLabels(clusterLabels(nodesRef.current), (c) => {
          ctx!.font = `600 ${clusterSize(c.count)}px ${CANVAS_FONT}`;
          return {
            x: c.x * k + tx,
            y: c.y * k + ty,
            w: ctx!.measureText(c.tag).width,
            h: clusterSize(c.count),
          };
        });
        for (const c of labels) {
          const size = clusterSize(c.count) / k;
          ctx!.font = `600 ${size}px ${CANVAS_FONT}`;
          // 글자 뒤를 종이색으로 한 번 그어 점 위에서도 읽히게 한다.
          ctx!.lineWidth = 4 / k;
          ctx!.strokeStyle = paperColor;
          ctx!.strokeText(c.tag, c.x, c.y);
          ctx!.fillStyle = tier === "clusters" ? inkColor : mutedColor;
          ctx!.fillText(c.tag, c.x, c.y);
        }
      }
      ctx!.restore();
    }
    drawRef.current = draw;

    // --- 힘 배치 ---------------------------------------------------------
    //
    // 선이 짧을수록(거리가 가까울수록) 더 세게 당긴다 — 그래야 "비슷한 것끼리
    // 뭉친다"가 화면에 나온다. 밀어내기가 없으면 한 점으로 모이고, 충돌이
    // 없으면 점이 겹쳐 개수를 못 읽는다.
    const sim = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance((e) => 24 + e.distance * 190)
          .strength((e) => Math.max(0.05, 1 - e.distance)),
      )
      .force("charge", forceManyBody<SimNode>().strength(-26).distanceMax(600))
      // 충돌 반경은 **월드 단위**다 — 배율과 무관해야 한다. 배율을 섞으면
      // 확대할 때마다 배치가 다시 흔들린다(자리는 확대와 상관없는 값이다).
      .force("collide", forceCollide<SimNode>().radius((n) => nodeScreenRadius(n) + 2))
      // 아주 약하게 가운데로 — 없으면 연결 없는 카드가 무한히 흘러간다.
      .force("x", forceX(0).strength(0.012))
      .force("y", forceY(0).strength(0.012))
      .alphaDecay(0.035)
      .on("tick", draw);
    simRef.current = sim;

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    // --- 팬/줌 -----------------------------------------------------------
    const sel = select<HTMLCanvasElement, unknown>(canvas);
    const zoomer = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.12, 6])
      .on("zoom", (ev: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        viewRef.current = { k: ev.transform.k, x: ev.transform.x, y: ev.transform.y };
        draw();
      });
    sel.call(zoomer);

    /**
     * 배치가 끝나면 **전체가 들어오게** 맞춘다.
     *
     * 처음 배율을 상수로 두면 카드 수에 따라 지도가 화면 가운데 얼룩이거나
     * 화면 밖으로 넘친다(실측 2026-08-06: 개념 76개에서 1,200개용 배율을 쓰니
     * 한가운데 작은 점 무리였다). 지도는 펼쳐진 채로 시작해야 지도다.
     *
     * **한 번만** 맞춘다 — 학생이 옮겨 놓은 화면을 배치가 식을 때마다 되돌리면
     * 지도를 볼 수가 없다.
     */
    let fitted = false;
    const fitToContent = () => {
      if (fitted || !width || !height) return;
      const b = boundsOf(nodesRef.current);
      if (!b) return;
      fitted = true;
      const pad = 48;
      const k = Math.min(
        6,
        Math.max(0.12, Math.min((width - pad * 2) / b.w, (height - pad * 2) / b.h)),
      );
      const t = zoomIdentity
        .translate(width / 2, height / 2)
        .scale(k)
        .translate(-(b.x + b.w / 2), -(b.y + b.h / 2));
      sel.call(zoomer.transform, t);
    };
    sim.on("end", fitToContent);
    // 배치가 아주 오래 식는 경우에도 학생을 기다리게 하지 않는다.
    const fitTimer = window.setTimeout(fitToContent, 2500);

    resize();

    return () => {
      window.clearTimeout(fitTimer);
      sim.stop();
      ro.disconnect();
      sel.on(".zoom", null);
      simRef.current = null;
    };
  }, [data]);

  /** 화면 좌표 → 가장 가까운 노드. 1,200개 선형 훑기는 마우스 이동당 마이크로초다. */
  const nodeAt = useCallback((sx: number, sy: number): SimNode | null => {
    const { k, x, y } = viewRef.current;
    const wx = (sx - x) / k;
    const wy = (sy - y) / k;
    // 잡히는 반경은 화면 기준으로 일정해야 한다 — 축소했을 때도 누를 수 있게.
    const reach = 10 / k;
    let best: SimNode | null = null;
    let bestD = reach * reach;
    for (const n of nodesRef.current) {
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }, []);

  const handleMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const hit = nodeAt(sx, sy);
      if (hit === hoverRef.current) return; // 같은 노드면 아무것도 안 한다
      hoverRef.current = hit;
      drawRef.current();
      // 툴팁 자리는 **여기서** 정한다. 렌더 중에 ref를 읽으면 React Compiler가
      // 막고(맞는 지적이다 — 그 값은 렌더의 입력이 아니다), 무엇보다 이 시점에
      // 이미 사각형을 갖고 있어서 다시 잴 이유가 없다.
      setHover(
        hit
          ? {
              node: hit,
              sx: Math.min(sx + 14, r.width - TIP_W),
              sy: Math.min(sy + 14, r.height - TIP_H),
            }
          : null,
      );
    },
    [nodeAt],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      const hit = nodeAt(e.clientX - r.left, e.clientY - r.top);
      if (hit) onOpen(hit);
    },
    [nodeAt, onOpen],
  );

  const handleLeave = useCallback(() => {
    hoverRef.current = null;
    drawRef.current();
    setHover(null);
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onClick={handleClick}
        className="h-full w-full cursor-grab active:cursor-grabbing"
      />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-accent-border/50 bg-bg-elevated px-3 py-2 shadow-lg"
          // 자리는 핸들러가 이미 화면 안으로 접어서 넣어 준다.
          style={{ left: hover.sx, top: hover.sy, width: TIP_W }}
        >
          {hover.node.tag && (
            <span className="text-[11px] font-medium text-accent-deep">
              {hover.node.tag}
            </span>
          )}
          <p className="text-sm font-medium text-fg">
            {hover.node.title || "제목 없는 개념"}
          </p>
          {hover.node.preview && (
            <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">
              {hover.node.preview}
            </p>
          )}
          <p className="mt-1 text-[11px] text-fg-muted/80">
            {sessionById.get(hover.node.session_id ?? "")?.title?.trim() ||
              "제목 없는 대화"}
            {" · 눌러서 이동"}
          </p>
        </div>
      )}
    </div>
  );
}
