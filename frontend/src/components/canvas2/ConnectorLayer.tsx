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

import { useEffect, useLayoutEffect, useRef } from "react";
import { ITEM_W, type Placed } from "@/lib/canvas2/layout";
import type { Size } from "@/lib/canvas2/useItemLayout";
import type { CanvasItem } from "@/lib/canvas2/types";
import type { Rect } from "@/lib/canvas2/rect";
import {
  center,
  cutPoint,
  linkPath,
  hitPathD,
  linkPathD,
  pointOnFan,
} from "@/lib/canvas2/connector";
import { treeEdges } from "@/lib/canvas2/tree";
import { useCollapsible } from "@/lib/canvas2/useCollapsible";
import { getDragOffsets, subscribeDrag, type DragOffset } from "@/lib/canvas2/dragBus";
import { getPushOffsets, subscribePush } from "@/lib/canvas2/pushBus";
import { getLiveLink, subscribeLink, type LiveLink } from "@/lib/canvas2/linkBus";

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  sizes: Map<string, Size>;
  /**
   * 연결을 끊는다 (D210 4-4). 없으면 ✕를 아예 그리지 않는다.
   *
   * 떼기 도구는 그대로 둔다 — 없애는 것이 아니라 **다른 길을 하나 더** 여는
   * 것이다(사용자 지시).
   */
  onCut?: (childId: string) => void;
}

/**
 * 아직 못 잰 카드의 기본 크기 (D206).
 *
 * 460이었다 — 배치 엔진의 `ITEM_W`(560)와 **달랐다.** 그래서 카드가 만들어진
 * 직후와 실측이 끝난 뒤의 기하가 서로 달라, 글이 채워지는 순간 연결선 끝점이
 * 툭 옮겨 갔다. 두 곳이 같은 값을 봐야 그 움직임이 사라진다.
 */
const FALLBACK: Size = { w: ITEM_W, h: 180 };

/** 포트 경로를 화폭 원점만큼 옮겨 SVG `d`로. */
/** 히트 선도 같은 오프셋으로 옮긴다 — 그리는 것과 잡히는 것이 어긋나면 안 된다. */
function shiftHit(g: ReturnType<typeof linkPath>, ox: number, oy: number): string {
  return hitPathD({
    a: { x: g.a.x - ox, y: g.a.y - oy },
    stem: { x: g.stem.x - ox, y: g.stem.y - oy },
    b: { x: g.b.x - ox, y: g.b.y - oy },
    c1: { x: g.c1.x - ox, y: g.c1.y - oy },
    c2: { x: g.c2.x - ox, y: g.c2.y - oy },
  });
}

function shiftPath(g: ReturnType<typeof linkPath>, ox: number, oy: number): string {
  return linkPathD({
    a: { x: g.a.x - ox, y: g.a.y - oy },
    stem: { x: g.stem.x - ox, y: g.stem.y - oy },
    b: { x: g.b.x - ox, y: g.b.y - oy },
    c1: { x: g.c1.x - ox, y: g.c1.y - oy },
    c2: { x: g.c2.x - ox, y: g.c2.y - oy },
  });
}
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
  /**
   * 카드에 딸린 것(강의 클립·교과서 도판)인가 (D163).
   *
   * 이것도 부모가 있지만 "AI 응답"이 아니다 — 라벨을 그대로 달면 클립 셋에
   * "AI 응답"이 셋 붙어 캔버스가 같은 글자로 뒤덮인다. 점선 가는 선으로
   * **딸려 있다**는 것만 보인다.
   */
  attach: boolean;
}

/** 카드 옆에 붙는 종류. layout.ts의 ATTACH_KINDS와 같은 목록이다. */
const ATTACH_KINDS = new Set(["clip", "figure"]);

/**
 * 끊기·붙기 중인 선의 색 (D180).
 *
 * 평소 연결선과 **다른 색**이어야 한다. 같은 색으로 두면 "이건 지금 손대는
 * 중"이라는 사실이 안 읽히고, 팽팽함도 굵기 변화만으로는 잘 안 보인다.
 */
const STRAIN_COLOR = "#e0a32e";
/** 붙을 수 있을 때의 색 — 학생의 틸(캔버스에서 "내가 만든 것"의 색). */
const SNAP_COLOR = "var(--c-live-deep)";

function shift(r: Rect, o: DragOffset | undefined): Rect {
  return o ? { ...r, x: r.x + o.dx, y: r.y + o.dy } : r;
}

/**
 * 끊기·붙기 중인 선 하나를 그린다 (D180).
 *
 * **속성만 고친다.** 노드는 렌더가 한 번 만들어 두고 여기서는 `d`·색·굵기만
 * 바꾼다 — 매 프레임 만들었다 지우면 그 사이 프레임에 선이 깜박이고, 이 기능의
 * 그래픽 사고는 대부분 그 깜박임이다.
 *
 * 세 얼굴이 있다:
 *
 *   장력   원래 부모에게 매여 있다. 팽팽할수록 **가늘어지고 밝아진다** —
 *          고무줄이 늘어나는 그림이다. 점선 간격도 벌어진다.
 *   끊김   `broke` 프레임에 굵게 번쩍인다. 다음 프레임에 사라진다.
 *   예고   붙을 후보로 향한다. 멀면 흐린 점선, 붙을 수 있으면 **실선**이다.
 */
function drawLive(
  svg: SVGSVGElement,
  live: LiveLink | null,
  rects: ReadonlyMap<string, Rect>,
  offsets: ReadonlyMap<string, DragOffset>,
  ox: number,
  oy: number,
): void {
  const g = svg.querySelector<SVGGElement>("[data-live-link]");
  if (!g) return;
  const path = g.querySelector<SVGPathElement>("[data-live-path]");
  const dot = g.querySelector<SVGCircleElement>("[data-live-dot]");
  const child = live ? rects.get(live.childId) : undefined;
  const parent = live?.parentId ? rects.get(live.parentId) : undefined;

  if (!live || !path || !child || !parent) {
    g.style.display = "none";
    return;
  }

  const pRect = shift(parent, offsets.get(live.parentId!));
  const cRect = shift(child, offsets.get(live.childId));
  const geo = linkPath(pRect, cRect);

  /**
   * **가까우면 곡선을 쓰지 않는다** (D180).
   *
   * 포트는 아래/위 변에서 바깥으로 밀어낸 점이다. 간격이 좁아지면
   * 그 두 점이 서로를 지나쳐 **선이 거꾸로 흐르고**, 제어점이 각자 바깥을
   * 향하므로 곡선이 카드 뒤에서 매듭이 되어 사라진다(실측 2026-08-06: 간격
   * 20에서 끝점이 시작점보다 위로 갔다). 학생 눈에는 "가까이 갈수록 연결이
   * 안 된다"로 보인다 — 사용자 보고가 정확히 그것이었다.
   *
   * 그때는 두 상자의 **중심을 잇는 직선**으로 떨어뜨린다. 짧아도 확실히
   * 보이고, 무엇과 무엇이 이어지는지가 그대로 읽힌다.
   */
  const span = Math.hypot(geo.b.x - geo.a.x, geo.b.y - geo.a.y);
  const folded = span < 56;
  const d = folded
    ? `M ${center(pRect).x - ox} ${center(pRect).y - oy} ` +
      `L ${center(cRect).x - ox} ${center(cRect).y - oy}`
    : shiftPath(geo, ox, oy);
  path.setAttribute("d", d);

  if (live.broke) {
    // 끊기는 순간 — 굵고 밝게 한 번. 상태가 아니라 사건이라 한 프레임이다.
    path.setAttribute("stroke", STRAIN_COLOR);
    path.setAttribute("stroke-width", "5");
    path.setAttribute("opacity", "1");
    path.removeAttribute("stroke-dasharray");
  } else if (live.strain > 0) {
    // 매여 있다 — 늘어날수록 가늘어지고 밝아진다.
    const t = live.strain;
    path.setAttribute("stroke", STRAIN_COLOR);
    path.setAttribute("stroke-width", String(2.6 - 1.5 * t));
    path.setAttribute("opacity", String(0.55 + 0.45 * t));
    // 간격이 벌어지는 점선 = 늘어나는 고무줄.
    path.setAttribute("stroke-dasharray", t > 0.35 ? `${6} ${2 + 14 * t}` : "");
  } else if (live.snapped) {
    path.setAttribute("stroke", SNAP_COLOR);
    path.setAttribute("stroke-width", "3.2");
    path.setAttribute("opacity", "0.95");
    path.removeAttribute("stroke-dasharray");
  } else {
    // 예고선 — 아직 안 붙었다. 흐리게.
    path.setAttribute("stroke", SNAP_COLOR);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("opacity", "0.35");
    path.setAttribute("stroke-dasharray", "4 7");
  }

  // 붙을 자리를 점으로 짚는다 — 붙는 순간에만, 그리고 곡선일 때만. 접힌
  // 직선에서는 끝점이 카드 안쪽이라 점이 글자 위에 얹힌다.
  if (dot) {
    dot.style.display = live.snapped && !folded ? "" : "none";
    dot.setAttribute("cx", String(geo.b.x - ox));
    dot.setAttribute("cy", String(geo.b.y - oy));
    dot.setAttribute("fill", SNAP_COLOR);
  }

  /**
   * **붙을 상대를 테두리로 짚는다** (D180).
   *
   * 선 하나에 기대면 가까울 때 신호가 사라진다 — 자리가 없어서 못 그리기
   * 때문이다. 테두리는 거리와 무관하게 읽히고, 여러 카드가 몰려 있어도
   * "이것에 붙는다"가 하나로 정해진다.
   */
  const ring = g.querySelector<SVGRectElement>("[data-live-ring]");
  if (ring) {
    ring.style.display = live.snapped ? "" : "none";
    ring.setAttribute("x", String(pRect.x - ox - 6));
    ring.setAttribute("y", String(pRect.y - oy - 6));
    ring.setAttribute("width", String(pRect.w + 12));
    ring.setAttribute("height", String(pRect.h + 12));
  }
  g.style.display = "";
}

export function ConnectorLayer({ items, positions, sizes, onCut }: Props) {
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
        attach: ATTACH_KINDS.has(child.kind),
      };
    });

  /**
   * 같은 부모의 자식들 — **가로 순서**와 개수 (D210 4-2).
   *
   * 부채가 벌어지는 방향과 폭이 이 둘로 정해진다. 가로로 정렬해 두면 왼쪽
   * 자식이 왼쪽으로 갈라져 선이 서로를 가로지르지 않는다.
   */
  const fan = new Map<string, { index: number; count: number }>();
  {
    const byParent = new Map<string, typeof links>();
    for (const l of links) {
      const arr = byParent.get(l.parentId) ?? [];
      arr.push(l);
      byParent.set(l.parentId, arr);
    }
    for (const arr of byParent.values()) {
      const sorted = [...arr].sort((a, b) => a.child.x - b.child.x);
      sorted.forEach((l, i) => fan.set(l.id, { index: i, count: sorted.length }));
    }
  }
  const fanOf = (id: string) => fan.get(id) ?? { index: 0, count: 1 };

  // 화폭 — 드래그 중에는 갱신하지 않는다(SVG는 overflow:visible이라 밖에도 그려진다).
  const geos = links.map((l) => {
    const f = fanOf(l.id);
    return linkPath(l.parent, l.child, f.index, f.count);
  });
  const xs = geos.flatMap((g) => [g.a.x, g.b.x, g.c1.x, g.c2.x, g.stem.x]);
  const ys = geos.flatMap((g) => [g.a.y, g.b.y, g.c1.y, g.c2.y, g.stem.y]);
  const minX = xs.length ? Math.min(...xs) - PAD : 0;
  const minY = ys.length ? Math.min(...ys) - PAD : 0;
  const w = xs.length ? Math.max(...xs) - minX + PAD : 0;
  const h = ys.length ? Math.max(...ys) - minY + PAD : 0;

  /**
   * 아이템 사각형 전부 — **붙으려는 상대는 지금 연결선이 없을 수도 있다** (D180).
   *
   * `links`는 이미 이어진 관계만 담는다. 자석이 걸린 후보로 예고선을 그리려면
   * 그 카드의 자리를 알아야 하는데 거기엔 없다.
   */
  const rects = new Map<string, Rect>();
  for (const it of items) {
    const p = positions.get(it.id);
    if (!p) continue;
    const sz = sizes.get(it.id) ?? FALLBACK;
    rects.set(it.id, { x: p.x, y: p.y, w: sz.w, h: sz.h });
  }

  const svgRef = useRef<SVGSVGElement>(null);
  // 드래그 콜백이 최신 링크·원점을 보게 한다(구독은 한 번만 건다).
  // **렌더 중에 ref를 쓰지 않는다** — React Compiler가 막는다(react-hooks/refs).
  const stateRef = useRef({ links, minX, minY, rects, fan });
  /**
   * ⚠️ **layout effect여야 한다** (사용자 보고 2026-08-09).
   *
   * 이 ref는 명령형 그리기(`draw`)가 읽는 기하다. 끌기가 끝나는 순간의
   * 그리기는 아이템의 `settle`이 부르는데 그것도 layout effect다 — 여기가
   * passive effect(`useEffect`)면 그때 **아직 옛 좌표**라서, 방금 React가
   * 낸 선을 옛 자리로 덮어썼다.
   *
   * 실측: 카드를 끌어 놓으면 자식 쪽 끝점이 옛 y에 남았고, `d` 문자열이
   * 우연히 같아 React가 DOM을 안 고치는 경우에는 **x가 두 배로 밀렸다**
   * (SVG 원점만 움직였다).
   *
   * `ConnectorLayer`는 `ItemLayer` 안에서 글보다 **먼저** 그려지므로 이
   * 이펙트도 먼저 돈다 — 그래서 `settle` 시점에는 이미 새 값이다.
   */
  useLayoutEffect(() => {
    stateRef.current = { links, minX, minY, rects, fan };
  });

  useEffect(() => {
    /**
     * 손에 들린 이동량 + **밀려난 이동량**을 합친다 (D210 4-5).
     *
     * 밀려나는 카드는 `dragBus`에 안 실린다(손에 들려 있지 않다). 그것만 보면
     * 밀린 카드의 연결선이 제자리에 남아 **끊겨 보이고**, 붙기 예고 테두리가
     * 카드와 어긋나 어디에 붙는지 알 수 없다.
     */
    const merged = (
      offsets: ReadonlyMap<string, DragOffset>,
    ): ReadonlyMap<string, DragOffset> => {
      const push = getPushOffsets();
      if (!push.size) return offsets;
      const out = new Map(offsets);
      for (const [id, d] of push) if (!out.has(id)) out.set(id, d);
      return out;
    };

    const draw = (raw: ReadonlyMap<string, DragOffset>) => {
      const offsets = merged(raw);
      const svg = svgRef.current;
      if (!svg) return;
      const { links: ls, minX: ox, minY: oy, rects: rs, fan: fs } = stateRef.current;
      const live = getLiveLink();

      /**
       * 끌리는 관계의 **원래 선은 숨긴다** (D180).
       *
       * 이것이 이 기능의 그래픽 원칙이다: **한 관계에 선은 언제나 하나.** 원래
       * 선을 둔 채 장력선을 얹으면 둘이 어긋난 채 겹쳐 보이고, 끊긴 뒤에도
       * 원래 선이 남아 "끊겼는데 이어져 있는" 그림이 된다.
       */
      const hidden = live?.childId ?? null;
      drawLive(svg, live, rs, offsets, ox, oy);

      for (const l of ls) {
        if (l.id === hidden) {
          const g = svg.querySelector<SVGGElement>(`[data-link="${CSS.escape(l.id)}"]`);
          if (g) g.style.display = "none";
          continue;
        }
        // 노드마다 ref를 다는 대신 조회한다. ref 콜백을 렌더에서 만들면
        // 그 안의 `ref.current` 접근이 렌더 중 접근으로 잡힌다.
        const g0 = svg.querySelector<SVGGElement>(`[data-link="${CSS.escape(l.id)}"]`);
        /**
         * ⚠️ **`querySelector("path")`는 히트 선을 집는다** (실측 2026-08-08).
         *
         * D211 3에서 손이 닿는 투명 선을 그룹 **맨 앞에** 넣었다. 그 뒤로
         * 여기서 집히는 것이 그 투명 선이라, 끄는 동안 **보이는 선은 한 번도
         * 갱신되지 않았다** — 카드만 가고 선은 제자리에 남았다(사용자 보고).
         * 히트 선은 아래에서 따로 옮긴다.
         */
        const path = g0?.querySelector<SVGPathElement>("path:not([data-link-hit])");
        if (!g0 || !path) continue;
        // 앞 드래그에서 숨겨 뒀으면 되살린다 — 안 그러면 선이 영영 안 보인다.
        if (g0.style.display === "none") g0.style.display = "";
        const n = {
          path,
          from: g0.querySelector<SVGCircleElement>('[data-end="from"]'),
          to: g0.querySelector<SVGCircleElement>('[data-end="to"]'),
          label: g0.querySelector("text"),
        };
        const f = fs.get(l.id) ?? { index: 0, count: 1 };
        const g = linkPath(
          shift(l.parent, offsets.get(l.parentId)),
          shift(l.child, offsets.get(l.id)),
          f.index,
          f.count,
        );
        const m = pointOnFan(g, 0.5);
        path.setAttribute("d", shiftPath(g, ox, oy));
        // 히트 선도 같이 옮긴다 — 안 옮기면 끌고 난 뒤 ✕가 **엉뚱한 자리**에서
        // 잡힌다(보이는 선과 잡히는 선이 갈린다).
        g0.querySelector("[data-link-hit]")?.setAttribute("d", shiftHit(g, ox, oy));
        const cut = g0.querySelector<SVGGElement>("[data-cut]");
        if (cut) {
          const c = cutPoint(g);
          cut.setAttribute("transform", `translate(${c.x - ox},${c.y - oy})`);
        }
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
    // **두 통로를 같은 그리기로 받는다.** 따로 그리면 한쪽만 갱신된 프레임에
    // 장력선과 카드가 어긋난다.
    const offDrag = subscribeDrag(draw);
    // 밀림이 갱신될 때도 다시 그린다 — 그래야 밀린 카드를 따라간다.
    const offPush = subscribePush(() => draw(getDragOffsets()));
    const offLink = subscribeLink(() => draw(getDragOffsets()));
    return () => {
      offDrag();
      offPush();
      offLink();
    };
  }, []);

  /**
   * 연결선이 하나도 없어도 **SVG는 남긴다** (D180).
   *
   * 예전에는 여기서 null을 냈다. 그러면 뿌리 카드 하나뿐인 캔버스에서 다른
   * 카드에 붙이려고 끌 때 예고선을 그릴 자리가 아예 없다 — 자석은 걸리는데
   * 화면에는 아무 일도 안 일어난다.
   */
  const empty = links.length === 0;

  return (
    <svg
      aria-hidden
      ref={svgRef}
      className="pointer-events-none absolute"
      style={{
        left: empty ? 0 : minX,
        top: empty ? 0 : minY,
        width: empty ? 1 : w,
        height: empty ? 1 : h,
        overflow: "visible",
      }}
      viewBox={empty ? "0 0 1 1" : `0 0 ${w} ${h}`}
    >
      {/**
       * 끊기·붙기 중인 선 (D180) — **언제나 하나뿐인 자리.**
       *
       * 렌더에서 만들어 두고 화면 갱신은 `drawLive`가 속성으로만 한다. 상태가
       * 바뀔 때마다 React로 만들었다 지웠다 하면 매 프레임 트리가 돌고, 지우는
       * 프레임과 그리는 프레임 사이에 선이 깜박인다.
       */}
      <g data-live-link style={{ display: "none" }}>
        {/* 붙을 상대의 테두리 — 선이 그려질 자리가 없을 때도 읽히는 신호다. */}
        <rect
          data-live-ring
          rx={12}
          fill="none"
          stroke={SNAP_COLOR}
          strokeWidth={2.5}
          strokeDasharray="10 7"
          opacity={0.9}
        />
        <path data-live-path fill="none" strokeLinecap="round" />
        <circle data-live-dot r={DOT_R + 1} />
      </g>
      {links.map((l, i) => {
        const g = geos[i];
        const m = pointOnFan(g, 0.5);
        const cut = cutPoint(g);
        return (
          <g key={l.id} data-link={l.id} style={{ color: "var(--c-live-deep)" }}>
            {/**
             * 손이 닿는 자리 (D211 3) — 보이지 않고 넓다.
             *
             * 그려진 선은 2.6px이라 그것만으로는 hover가 사실상 안 잡힌다
             * (사용자 보고: "연결선에 가져가도 ✕가 안 뜬다"). 같은 곡선을
             * 굵게 한 번 더 그리고 투명하게 둔다. 첨부(점선)에는 ✕가 없으므로
             * 히트 선도 없다.
             */}
            {onCut && !l.attach && (
              <path
                data-link-hit
                d={shiftHit(g, minX, minY)}
                fill="none"
                stroke="transparent"
                strokeWidth={22}
                strokeLinecap="round"
                style={{ pointerEvents: "stroke", cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCut(l.id);
                }}
              />
            )}
            <path
              d={shiftPath(g, minX, minY)}
              fill="none"
              stroke="currentColor"
              /**
               * 1.1/0.28 → 1.6~2.6이었다가(2026-08-03 "더 굵게") **다시 한
               * 단계 얇아졌다**(UI 개편 2026-08-11: "연결선은 더 얇고 연하게").
               *
               * 그때 굵힌 이유는 카드가 커져 실오라기처럼 보였기 때문인데,
               * 개편이 카드에서 테두리·그림자를 걷어내 화면이 조용해진 만큼
               * 같은 굵기가 이제 도드라진다. 3px보다 아래로는 안 내린다 —
               * 그 아래는 배율이 낮을 때 사라진다.
               */
              strokeWidth={l.attach ? 1.2 : l.tree ? 1.9 : 1.5}
              strokeLinecap="round"
              // 첨부는 점선이다 (D163) — 트리 간선과 한눈에 갈린다.
              strokeDasharray={l.attach ? "5 6" : undefined}
              opacity={l.attach ? 0.3 : l.tree ? 0.42 : 0.38}
            />
            {/* 양끝 도트 — 어디서 나와 어디로 갔는지가 한눈에 보인다.
                받는 쪽만 가운데를 종이색으로 비워 방향을 표시한다. */}
            <circle
              data-end="from"
              cx={g.a.x - minX}
              cy={g.a.y - minY}
              r={l.attach ? DOT_R - 1 : l.tree ? DOT_R + 0.5 : DOT_R}
              fill="currentColor"
              opacity={l.attach ? 0.5 : l.tree ? 0.8 : 0.85}
            />
            <circle
              data-end="to"
              cx={g.b.x - minX}
              cy={g.b.y - minY}
              r={l.attach ? DOT_R - 1 : l.tree ? DOT_R + 0.5 : DOT_R}
              fill="var(--c-paper)"
              stroke="currentColor"
              strokeWidth={l.attach ? 1.4 : 2}
              opacity={l.attach ? 0.6 : l.tree ? 0.9 : 0.95}
            />
            {/**
             * 끊기 버튼 (D210 4-4).
             *
             * **자식 쪽 끝 구간**에 둔다 — 자식의 위 포트에는 선이 하나뿐이라
             * 절대 겹치지 않는다. 공유 줄기에서는 어느 선인지 가릴 수 없으므로
             * 거기에는 절대 두지 않는다(`cutPoint`가 그 자리를 정한다).
             *
             * 평소에는 안 보이고 선이나 ✕에 손이 닿을 때만 뜬다 — 카드마다
             * ✕가 상시로 떠 있으면 캔버스가 버튼밭이 된다.
             */}
            {onCut && !l.attach && (
              <g
                data-cut
                data-no-pan
                transform={`translate(${cut.x - minX},${cut.y - minY})`}
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCut(l.id);
                }}
              >
                <title>연결 끊기</title>
                {/* 손이 닿는 자리는 넉넉하게, 보이는 것은 작게. */}
                <circle r={13} fill="transparent" style={{ pointerEvents: "all" }} />
                <circle
                  className="c2-cut-dot"
                  r={7.5}
                  fill="var(--c-paper)"
                  stroke="currentColor"
                  strokeWidth={1.6}
                />
                <path
                  className="c2-cut-dot"
                  d="M -3 -3 L 3 3 M 3 -3 L -3 3"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                />
              </g>
            )}
            {/* 트리 간선에는 라벨을 달지 않는다 — 카드마다 하나씩이라
                "AI 응답"이 캔버스를 뒤덮는다 (D151). 첨부도 마찬가지다(D163). */}
            {!l.tree && !l.attach && (
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
