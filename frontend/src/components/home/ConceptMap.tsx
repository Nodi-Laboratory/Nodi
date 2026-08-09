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
import { MapZoomControls } from "@/components/home/MapZoomControls";
import type { ConceptMapData, ConceptNode } from "@/lib/api/conceptMap";
import { pastelForTag } from "@/lib/ui/pastel";
import {
  boundsOf,
  clusterLabels,
  degrees,
  pickSpacedLabels,
  seedPositions,
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
  /**
   * 지도에서 **숨긴** 대화 (D191).
   *
   * 힘 배치는 이 값을 안 본다 — 자리는 전체 노드로 한 번 정해지고, 여기서는
   * **그리기만** 거른다. 필터마다 다시 배치하면 체크 하나에 지도 전체가
   * 헤엄치는데, 그건 D189가 명시적으로 버린 성질이다("어제 왼쪽 위에 있던
   * 무리가 오늘 오른쪽에 있으면 지도가 아니라 매번 새 그림이다").
   */
  hiddenSessions: ReadonlySet<string>;
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

/**
 * 테마 토큰(헥스)에 알파를 입힌다 (D203).
 *
 * canvas 2D의 `ctx`는 CSS 변수를 못 읽으므로 `getComputedStyle`로 헥스를
 * 받아 오는데, 반투명하게 그으려면 rgba가 필요하다.
 *
 * 헥스가 아니면(`color-mix()` 같은 값으로 바뀌면) **알파를 포기하고 원래
 * 값을 그대로 돌려준다** — 선이 안 그려지는 것보다 불투명하게 그려지는
 * 쪽이 낫다. 여기서 던지면 지도 전체가 빈 화면이 된다.
 */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function ConceptMap({ data, onOpen, hiddenSessions }: ConceptMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);
  /**
   * 위쪽 몇 px이 UI에 덮여 있나 (사용자 지시 2026-08-09).
   *
   * 홈이 `[data-map-overlay]`를 씌운다. **자리를 그때그때 잰다** — 프롭으로
   * 받으면 홈의 문구가 한 줄 늘 때마다 숫자를 손으로 옮겨야 하고, 그 숫자는
   * 반드시 어긋난다. ref에 담는 이유는 이 값이 렌더가 아니라 **d3 이펙트
   * 안에서** 쓰이기 때문이다.
   */
  const uiTopRef = useRef(0);

  /** 화면 변환. React state로 두면 팬/줌마다 전체가 다시 돈다(D124와 같은 이유). */
  const viewRef = useRef({ k: 0.5, x: 0, y: 0 });
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const hoverRef = useRef<SimNode | null>(null);
  const drawRef = useRef<() => void>(() => {});
  /**
   * 숨김 집합을 **ref로도** 들고 있는다 (D191).
   *
   * 프롭을 그리기 이펙트의 deps에 넣으면 체크 하나에 힘 배치가 통째로 다시
   * 선다 — 1,200노드가 매 클릭마다 재배치된다. 값은 ref로 흘리고 다시
   * 그리기만 부른다.
   */
  const hiddenRef = useRef<ReadonlySet<string>>(hiddenSessions);
  /** 확대 버튼이 쓰는 손잡이. 이펙트 안에서만 만들 수 있어 ref로 꺼내 둔다. */
  const zoomApiRef = useRef<{ zoomBy: (f: number) => void; fit: () => void } | null>(
    null,
  );

  /** hover한 개념 — 이것만 React가 안다(툴팁 하나 그리는 값이다). */
  const [hover, setHover] = useState<{ node: ConceptNode; sx: number; sy: number } | null>(
    null,
  );

  const sessionById = useMemo(
    () => new Map(data.sessions.map((s) => [s.id, s])),
    [data.sessions],
  );

  /**
   * 지금 보이는 개념 수.
   *
   * `session_id`가 없는 카드는 어느 대화에도 안 딸리므로 `""`로 조회되고,
   * 숨김 집합에 그런 키가 없어 **언제나 보인다** — 끌 수단이 없는 것을 꺼진
   * 것처럼 세면 "전부 숨겼습니다"가 거짓말이 된다.
   */
  /**
   * 배치가 아직 식는 중인가 (D211 1).
   *
   * d3 힘 시뮬레이션은 200틱 남짓 돌면서 매 틱 다시 그린다 — 학생이 보는 것은
   * 노드가 꿈틀대며 자리를 찾는 장면이고, 그게 "렉"으로 읽힌다(사용자 보고
   * 2026-08-08). 계산을 멈추지 않고 **가리기만** 한다: 멈췄다 한 번에 보여
   * 주면 그동안 계산이 안 돌아 오히려 더 오래 걸린다.
   */
  const [settling, setSettling] = useState(true);

  const visibleCount = useMemo(
    () =>
      data.nodes.reduce(
        (n, x) => (hiddenSessions.has(x.session_id ?? "") ? n : n + 1),
        0,
      ),
    [data.nodes, hiddenSessions],
  );

  // 숨김이 바뀌면 배치는 그대로 두고 **다시 그리기만** 한다.
  useEffect(() => {
    hiddenRef.current = hiddenSessions;
    drawRef.current();
  }, [hiddenSessions]);

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
    const inkColor = tone("--fg", "#1e2418");
    const mutedColor = tone("--fg-muted", "#5f6656");
    const paperColor = tone("--bg-elevated", "#ffffff");
    /**
     * 선 색 (D203).
     *
     * `--c-live`(AI 초록)를 먼저 본다 — 캔버스와 같은 뜻의 선이기 때문이다.
     * 다만 그 토큰은 `.canvas2` 안에서만 정의되고 이 지도는 홈 화면이라,
     * 실제로는 **디자이너의 중간 톤 `--accent-mid`로 떨어진다.**
     *
     * 뒤를 `--accent-deep`(버튼용 어두운 초록)으로 뒀다가 화면에서 보고
     * 바꿨다 — 선은 알파 0.06~0.28로 옅게 긋는 것이라 어두운 값을 쓰면
     * 캔버스 괘선보다 칙칙한 카키로 깔린다. 여기는 글자를 얹는 자리가
     * 아니므로 밝은 쪽을 쓸 수 있다.
     *
     * **어느 쪽이든 브랜드 토큰이라 다음에 색을 바꿔도 여기가 따라온다** —
     * 예전에는 이 자리에 `rgba(160,101,3,…)`가 박혀 있어 토큰을 아무리
     * 고쳐도 조용히 오커로 남았고, 지도를 열어 봐야만 드러났다.
     */
    const linkColor = tone("--c-live", tone("--accent-mid", "#9ec92e"));

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

    /**
     * 이 개념이 지금 보이나 (D191).
     *
     * ⚠️ **거르는 곳이 다섯이고 하나라도 빠지면 조용히 틀린다** — 선·점·
     * 제목·무리 이름·히트 판정. 제목을 안 거르면 없는 점 위에 이름만 뜨고,
     * 히트 판정을 안 거르면 **안 보이는 점이 눌려** 엉뚱한 대화로 간다.
     */
    function isVisible(n: SimNode): boolean {
      return !hiddenRef.current.has(n.session_id ?? "");
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
          // 양 끝이 다 보일 때만 — 한쪽만 보이면 허공으로 뻗는 선이 된다.
          if (!s || !t || !isVisible(s) || !isVisible(t)) continue;
          // 가까운 쌍일수록 진하게. 먼 쌍까지 같은 농도로 그으면 구조가 묻힌다.
          const strength = Math.max(0, 1 - e.distance / 0.7);
          ctx!.strokeStyle = withAlpha(linkColor, 0.06 + strength * 0.22);
          ctx!.beginPath();
          ctx!.moveTo(s.x, s.y);
          ctx!.lineTo(t.x, t.y);
          ctx!.stroke();
        }
      }

      // --- 노드 ---------------------------------------------------------
      const hovered = hoverRef.current;
      for (const n of nodesRef.current) {
        if (!isVisible(n)) continue;
        // 화면 크기를 배율로 나눠 월드 단위로 — 결과가 확대와 무관하게 일정하다.
        const r = nodeScreenRadius(n) / k;
        const dotColor = pastelForTag(n.tag);
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, r, 0, Math.PI * 2);
        /**
         * **파스텔 한 벌에서 고른다** (사용자 지시 2026-08-09).
         *
         * 예전에는 이름 해시로 hue를 만들어 `hsl(h 62% 52%)`를 썼다. 그
         * 채도로는 이 지도가 **홈의 배경**이 된 지금 위에 뜬 글씨와 다툰다.
         * 목록이 유한한 것도 이점이다 — 연속 hue는 이웃한 두 분류가 사실상
         * 같은 색으로 뽑히는 일이 생긴다.
         *
         * 분류가 없는 점은 목록의 중립색이다. 예전처럼 `--fg-muted`를 옅게
         * 깔면 파스텔 옆에서 혼자 회색으로 떠 보인다.
         */
        ctx!.fillStyle = dotColor;
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
        const named = nodesRef.current.filter(
          (n) => isVisible(n) && (n.title || n.preview),
        );
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
        const labels = pickSpacedLabels(
          clusterLabels(nodesRef.current.filter(isVisible)),
          (c) => {
            ctx!.font = `600 ${clusterSize(c.count)}px ${CANVAS_FONT}`;
            return {
              x: c.x * k + tx,
              y: c.y * k + ty,
              w: ctx!.measureText(c.tag).width,
              h: clusterSize(c.count),
            };
          },
        );
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
    //
    // ## 지도 위에서는 결과가 하나다 (D191)
    //
    // 예전에는 **같은 손동작이 커서 위치에 따라 두 결과**를 냈다 — 캔버스 안이면
    // 지도가, 헤더나 여백이면 브라우저가 확대됐다. 학생이 실제로 겪은 것은
    // "확대했더니 웹 화면이 커졌고, 되돌리려니 지도가 줄어든" 것이다
    // (사용자 보고 2026-08-06).
    //
    // 캔버스 위의 휠은 **ctrl 여부와 무관하게** 지도가 먹고 브라우저로 안
    // 넘긴다. d3가 대개 막아 주지만 핀치(ctrl+wheel)는 브라우저·OS 조합에
    // 따라 새고, 그 한 경우가 위 증상이다. d3보다 **먼저** 걸어 두어야
    // d3의 필터가 거절하는 경우까지 덮는다(우리는 preventDefault만 하고
    // 전파를 안 끊으므로 d3의 확대는 그대로 돈다).
    const blockPageZoom = (e: WheelEvent) => e.preventDefault();
    canvas.addEventListener("wheel", blockPageZoom, { passive: false });

    const sel = select<HTMLCanvasElement, unknown>(canvas);
    const zoomer = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.12, 6])
      // 기본값과 같지만 **명시한다** — 이 화면이 "ctrl+휠도 지도"라는 필터에
      // 기대고 있다는 사실이 코드에 남아야 다음 사람이 안 뒤집는다.
      .filter((e: Event) => !(e as MouseEvent).button)
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
     * 저절로는 **한 번만** 맞춘다 — 학생이 옮겨 놓은 화면을 배치가 식을 때마다
     * 되돌리면 지도를 볼 수가 없다. 버튼(`force`)은 그 빗장을 넘는다.
     *
     * **보이는 개념만** 담는다 (D191). 대화를 끄면 그 자리에 구멍이 남는데,
     * 재배치 없이 그 구멍을 푸는 방법이 이것이다 — 남은 것에 맞춰 당기면
     * 구멍은 화면 밖으로 밀린다.
     */
    let fitted = false;
    const fitToContent = (force = false) => {
      if ((fitted && !force) || !width || !height) return;
      // 덮개는 지도 위에 절대 배치로 얹혀 있다 — 그 아래 변이 곧 우리 천장이다.
      const wrapBox = wrapRef.current?.getBoundingClientRect();
      const uiBox = document
        .querySelector("[data-map-overlay]")
        ?.getBoundingClientRect();
      uiTopRef.current = wrapBox && uiBox ? Math.max(0, uiBox.bottom - wrapBox.top) : 0;
      const shown = nodesRef.current.filter(isVisible);
      // 전부 껐으면 안내 문구가 덮으므로 배율은 아무래도 좋다 — 그래도
      // 전체로 맞춰 두어야 다시 켰을 때 엉뚱한 자리에 있지 않다.
      const b = boundsOf(shown.length ? shown : nodesRef.current);
      if (!b) return;
      fitted = true;
      // 자리가 잡힌 그 순간이 곧 보여 줄 때다 — 따로 재지 않는다.
      setSettling(false);
      const pad = 48;
      /**
       * **덮인 자리는 빼고 잰다** (사용자 지시 2026-08-09).
       *
       * 홈에서는 이 지도 위에 인사말·입력창·버튼이 얹힌다. 화면 전체로 맞추면
       * 노드 무리의 한가운데가 정확히 그 글자들 뒤에 깔린다 — 지도가 보이라고
       * 배경으로 둔 것인데 가장 붐비는 곳이 가려지는 셈이다.
       *
       * 그래서 **덮인 아래쪽만**을 화면으로 치고 거기에 맞춘다. 남는 높이가
       * 너무 얇으면(작은 화면) 맞추기가 무의미해지므로 하한을 둔다.
       */
      const top = Math.min(uiTopRef.current, height * 0.6);
      /**
       * 아래 띠는 **여백을 아낀다**(pad의 절반).
       *
       * 위쪽을 UI에 내주고 나면 남는 높이가 화면의 절반도 안 된다. 거기에
       * 좌우와 같은 여백까지 물리면 무리가 손톱만 해져서, "한눈에 보이게"
       * 하려던 것이 도리어 안 보이게 된다(실측 2026-08-09: 810 화면에서
       * 쓸 수 있는 높이가 290px).
       */
      const usableH = Math.max(120, height - top - pad);
      const k = Math.min(
        6,
        Math.max(0.12, Math.min((width - pad * 2) / b.w, usableH / b.h)),
      );
      const t = zoomIdentity
        .translate(width / 2, top + (height - top) / 2)
        .scale(k)
        .translate(-(b.x + b.w / 2), -(b.y + b.h / 2));
      sel.call(zoomer.transform, t);
    };
    sim.on("end", () => fitToContent());
    // 배치가 아주 오래 식는 경우에도 학생을 기다리게 하지 않는다.
    const fitTimer = window.setTimeout(() => fitToContent(), 2500);

    // 확대 버튼이 쓸 손잡이. `zoomer`·`sel`은 이 이펙트 밖에서 못 만든다.
    zoomApiRef.current = {
      zoomBy: (f) => sel.call(zoomer.scaleBy, f),
      fit: () => fitToContent(true),
    };

    resize();

    return () => {
      window.clearTimeout(fitTimer);
      sim.stop();
      ro.disconnect();
      sel.on(".zoom", null);
      canvas.removeEventListener("wheel", blockPageZoom);
      zoomApiRef.current = null;
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
      // 숨긴 대화의 개념은 안 잡힌다 (D191) — 안 거르면 **안 보이는 점이
      // 눌려** 학생이 끄기로 한 대화로 끌려간다.
      if (hiddenRef.current.has(n.session_id ?? "")) continue;
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

  const zoomIn = useCallback(() => zoomApiRef.current?.zoomBy(1.6), []);
  const zoomOut = useCallback(() => zoomApiRef.current?.zoomBy(1 / 1.6), []);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden"
      /* 캔버스는 픽셀로 못 센다 — e2e가 필터를 확인하는 신호다(D176 `data-strokes`). */
      data-visible-nodes={visibleCount}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onClick={handleClick}
        /* `touch-none`: 트랙패드·터치 핀치가 페이지 확대로 새지 않게 한다. */
        className="h-full w-full touch-none cursor-grab active:cursor-grabbing"
      />

      <MapZoomControls onZoomIn={zoomIn} onZoomOut={zoomOut} />

      {/**
       * 식는 동안 덮는다 (D211 1).
       *
       * 노드가 흔들리는 것을 보여 주는 것보다 잠깐 가리는 편이 낫다 — 흔들림은
       * 학생 눈에 고장으로 읽힌다. 배율 맞추기가 끝나는 순간에 걷힌다.
       */}
      {settling && (
        <div
          data-map-settling
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-bg-elevated/85"
        >
          <span className="text-sm font-medium text-fg">지도를 그리는 중…</span>
          <span className="text-xs text-fg-muted">개념들이 자리를 잡고 있어요</span>
        </div>
      )}

      {/*
        전부 껐을 때 빈 캔버스로 두지 않는다 — 빈 화면은 고장과 구분되지
        않는다(`EmptyMap`과 같은 태도). 무엇을 하면 돌아오는지 말해 준다.
      */}
      {visibleCount === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg-elevated/80 px-4 text-center">
          <p className="text-sm font-medium text-fg">지도에 띄운 대화가 없습니다</p>
          <p className="text-xs text-fg-muted">왼쪽 목록에서 볼 대화를 켜세요.</p>
        </div>
      )}

      {/*
        hover한 개념이 방금 숨겨졌을 수 있다 — 마우스가 멈춰 있으면 다음
        mousemove가 안 와서 툴팁만 남는다. 렌더 중에 걸러 낸다(이펙트로 지우면
        한 프레임 어긋나고 React Compiler 규칙에도 걸린다).
      */}
      {hover && !hiddenSessions.has(hover.node.session_id ?? "") && (
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
