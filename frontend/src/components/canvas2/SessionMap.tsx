"use client";

/**
 * 대화방 지도 — **캔버스에서 떼어낸 별도 화면** (D205).
 *
 * ## 왜 떼어냈나
 *
 * 캔버스 위에 지도·도구 레일·질문창·사이드바·상단바가 전부 떠 있어서 정작
 * 캔버스가 좁아 보였다. 그 때문에 지도를 키울 수가 없었고, 작은 지도는
 * 노드가 뭉쳐 읽히지 않았다(사용자 지시 2026-08-07). 지도를 자기 화면으로
 * 옮기면 둘 다 풀린다 — 캔버스는 넓어지고 지도는 커진다.
 *
 * ## 왜 화면을 꽉 채우지 않는가
 *
 * 지도를 화면 전체로 만들면 **브라우저 확대와 지도 확대가 섞인다.** 어디를
 * 굴려도 뭔가가 커지는데 둘 중 무엇이 커졌는지 알 수 없다. 테두리가 뚜렷한
 * 상자 안에 가두면 "이 안이 지도"라는 경계가 생기고, 휠은 그 안에서만 먹는다.
 *
 * ## 미니맵과 무엇이 다른가
 *
 * 캔버스에 얹혀 있던 미니맵은 **지금 보는 영역**을 알려 주는 것이 절반의
 * 일이었다(뷰포트 사각형). 여기에는 볼 캔버스가 없으므로 그 개념이 없다.
 * 대신 이 화면만 할 수 있는 둘이 생겼다:
 *
 *   · 확대하면 노드마다 **제목**이 아래에 붙는다 (미니맵에서는 뿌리 태그만).
 *   · 노드를 끌면 **실제 카드 좌표가 움직인다** (미니맵에서는 못 했다).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Minus, Plus, Maximize2 } from "lucide-react";
import type { CanvasItem } from "@/lib/canvas2/types";
import type { Size } from "@/lib/canvas2/useItemLayout";
import { ITEM_W } from "@/lib/canvas2/layout";
import { buildTrees, treeEdges, LOOSE_TAG } from "@/lib/canvas2/tree";
import type { Rect } from "@/lib/canvas2/rect";
import { PASTEL_COLORS } from "@/lib/ui/pastel";

/**
 * 태그 색 — **파스텔 한 벌**(사용자 지시 2026-08-09, `lib/ui/pastel.ts`).
 *
 * 홈 개념 지도와 같은 목록을 쓴다. 지도가 셋인데 색을 각자 갖고 있으면 같은
 * 분류가 화면마다 다른 색으로 뜨고, 학생 눈에는 서로 다른 것으로 읽힌다.
 */
const TREE_COLORS = [...PASTEL_COLORS];

const UNTAGGED = LOOSE_TAG;
const FALLBACK: Size = { w: ITEM_W, h: 180 };

/** 지도 안쪽 여백(px). 노드가 테두리에 붙으면 잘린 것처럼 보인다. */
const PAD = 44;
/** 노드 점 반지름. */
const NODE_R = 6;
/** 이 배율부터 낱개 노드 지도로 바뀐다. 아래로는 태그 덩어리만 보인다. */
const NODE_ZOOM = 1.8;
/** 이 배율부터 노드 **제목**이 아래에 붙는다 (사용자 지시 2026-08-07). */
const TITLE_ZOOM = 2.6;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.3;
/** 제목이 길면 자른다 — 옆 노드를 덮으면 지도가 아니라 글 목록이 된다. */
const TITLE_MAX = 14;
/** 끌기로 인정하는 최소 이동(px). 이보다 작으면 클릭이다. */
const DRAG_MIN = 4;

function union(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function radius(count: number): number {
  return Math.max(9, Math.min(26, 9 + Math.sqrt(count) * 4));
}

/**
 * 노드에 붙일 이름.
 *
 * 제목이 없으면 본문 앞을 쓰는데, 본문에는 **전선 형식이 그대로** 들어 있다
 * (`@concept: 광합성 | 생명과학`). 그걸 지도에 찍으면 학생이 못 읽는다 —
 * 형식은 우리 사정이지 학생의 것이 아니다.
 */
function nodeTitle(title: string | null | undefined, body: string): string {
  const t = title?.trim();
  if (t) return t;
  const first = body.split("\n").find((l) => l.trim()) ?? "";
  const m = /^@concept:\s*(.+)$/.exec(first.trim());
  const raw = m ? m[1] : first;
  // `제목 | 분류` 꼴이면 제목만 쓴다.
  return raw.split("|")[0].replace(/\s+/g, " ").trim().slice(0, 24);
}

export interface SessionMapProps {
  items: CanvasItem[];
  positions: Map<string, { x: number; y: number }>;
  sizes: Map<string, Size>;
  tagOrder: readonly string[];
  /** 지도 상자의 화면 크기(px). 페이지가 잰 값을 넘긴다. */
  box: { w: number; h: number };
  /**
   * 좁은 상자(미니맵)인가 (D211 7).
   *
   * 같은 컴포넌트가 미니맵·팝업·페이지 셋에 쓰인다(D210 5-2). 상자가 작아지면
   * 크롬도 같이 작아져야 지도 볼 자리가 남는다 — 셋이 갈라지지 않게 **크기만**
   * 프롭으로 받고 규칙은 여기 한 곳에 둔다.
   */
  compact?: boolean;
  /** 노드를 눌렀다 — 캔버스로 돌아가 그 카드를 본다. */
  onOpen: (itemId: string) => void;
  /** 노드를 끌어 옮겼다 — **실제 카드 좌표**가 바뀐다. */
  onMoveNode: (id: string, x: number, y: number) => void;
}

export function SessionMap({
  items,
  positions,
  sizes,
  tagOrder,
  box,
  compact = false,
  onOpen,
  onMoveNode,
}: SessionMapProps) {
  const [zoom, setZoom] = useState(1);
  /** 학생이 끌어 옮긴 중심(world). null이면 내용 전체를 담는다. */
  const [pan, setPan] = useState<{ x: number; y: number } | null>(null);
  /** 판을 끄는 중. 노드를 끄는 것과 구분한다. */
  const panRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  /** 노드를 끄는 중 — id와 시작 world 좌표. */
  const nodeRef = useRef<{ id: string; sx: number; sy: number; x0: number; y0: number } | null>(
    null,
  );
  /** 방금 동작이 끌기였나. pointerup이 click보다 먼저 돌아 ref로는 못 본다. */
  const movedRef = useRef(false);
  /**
   * 판을 끄는 동안 내용을 담는 그룹 — **여기만 민다.**
   *
   * 예전에는 pointermove마다 `setPan`을 불렀다. 그러면 매 프레임 트리를 다시
   * 세우고(`buildTrees`) 간선을 다시 잇고 SVG 노드 전부를 다시 렌더한다 —
   * 손보다 늦게 따라온다. 지도를 끄는 것은 **화면 좌표를 그대로
   * 평행이동**하는 것과 같으므로 transform 하나로 정확히 같은 결과가 나온다
   * (캔버스 팬이 쓰는 방법과 같다, D124). 손을 뗄 때 한 번만 state로 올린다.
   */
  const contentRef = useRef<SVGGElement>(null);
  /**
   * 끄는 동안 보이는 자리는 **DOM을 직접 고쳐** 옮긴다.
   *
   * ref로 붙잡으면 안 된다 — 어느 노드가 잡혔는지는 렌더 중에 알 수 없고
   * (React Compiler가 렌더 중 ref 읽기를 막는다), state로 올리면 매 프레임
   * 지도 전체가 다시 계산돼 손보다 늦게 따라온다. 원래 자리는 `data-bx/by`에
   * 적어 두므로 이동량만 더하면 된다.
   */
  const nodeElAt = (id: string) =>
    document.querySelector<SVGGElement>(`[data-map-node="${CSS.escape(id)}"]`);

  /**
   * ⚠️ **하한이 미니맵을 넘치게 했다** (실측 2026-08-08).
   *
   * 200px 하한은 페이지·팝업에서 "너무 납작한 지도"를 막으려던 것인데,
   * 미니맵의 지도 자리는 176px이라 그 하한이 이겨 상자가 **24px 넘쳤다.**
   * 미니맵은 `overflow: hidden`이라 넘친 만큼이 잘렸고, 하필 그 자리에
   * 배율 버튼이 있어 "테두리에 잘린다"로 보고됐다.
   *
   * 좁은 상자에서는 하한을 낮춘다 — 준 자리를 넘지 않는 것이 먼저다.
   */
  const FLOOR = compact ? 110 : 200;
  const W = Math.max(FLOOR, box.w);
  const H = Math.max(FLOOR, box.h);

  const model = useMemo(() => {
    // id → 아이템. 예전에는 노드마다 `items.find(...)`를 돌아 카드 수의
    // 제곱이었다 — 150장이면 22,500번이고 그게 팬 프레임마다 돌았다.
    const byId = new Map(items.map((i) => [i.id, i]));
    const rectOf = (id: string): Rect | null => {
      const p = positions.get(id);
      if (!p) return null;
      const s = sizes.get(id) ?? FALLBACK;
      return { x: p.x, y: p.y, w: s.w, h: s.h };
    };

    // `ids`는 **누를 때 갈 곳**을 위해 함께 모은다 (사용자 지시 2026-08-09).
    // `items`가 seq 순서라 첫 id가 그 트리의 시작이다.
    const byTag = new Map<string, { rects: Rect[]; ids: string[] }>();
    for (const it of items) {
      const r = rectOf(it.id);
      if (!r) continue;
      const tag = it.tag || UNTAGGED;
      const cur = byTag.get(tag) ?? { rects: [], ids: [] };
      cur.rects.push(r);
      cur.ids.push(it.id);
      byTag.set(tag, cur);
    }
    if (!byTag.size) return null;

    const order = [...tagOrder, ...byTag.keys()].filter(
      (t, i, a) => a.indexOf(t) === i && byTag.has(t),
    );
    const colorOf = (tag: string) =>
      TREE_COLORS[Math.max(0, order.indexOf(tag)) % TREE_COLORS.length];

    const boxAll = union([...byTag.values()].flatMap((g) => g.rects))!;
    // **양축에 같은 배율.** 다르게 주면 나란한 열이 비스듬해 보여 공간 정보가
    // 거짓이 된다(미니맵과 같은 규칙).
    const fit = Math.min(
      (W - PAD * 2) / Math.max(1, boxAll.w),
      (H - PAD * 2) / Math.max(1, boxAll.h),
    );
    const s = fit * zoom;
    const cx = pan ? pan.x : boxAll.x + boxAll.w / 2;
    const cy = pan ? pan.y : boxAll.y + boxAll.h / 2;
    const px = (x: number) => W / 2 + (x - cx) * s;
    const py = (y: number) => H / 2 + (y - cy) * s;

    const trees = buildTrees(items);
    const depthOf = new Map<string, number>();
    for (const t of trees) for (const [id, d] of t.depth) depthOf.set(id, d);
    const centerOf = (id: string) => {
      const r = rectOf(id);
      return r ? { x: px(r.x + r.w / 2), y: py(r.y + r.h / 2) } : null;
    };

    const nodes = trees.flatMap((t) =>
      t.order.flatMap((id) => {
        const c = centerOf(id);
        const r = rectOf(id);
        if (!c || !r) return [];
        const it = byId.get(id);
        return [
          {
            id,
            tag: t.tag,
            title: nodeTitle(it?.title, it?.body ?? ""),
            root: (depthOf.get(id) ?? 0) === 0,
            color: colorOf(t.tag),
            ...c,
            world: { x: r.x, y: r.y },
          },
        ];
      }),
    );
    const treeIds = new Set(nodes.map((n) => n.id));
    const loose = items.flatMap((it) => {
      if (treeIds.has(it.id)) return [];
      const c = centerOf(it.id);
      const r = rectOf(it.id);
      if (!c || !r) return [];
      return [
        {
          id: it.id,
          title: nodeTitle(it.title, it.body),
          color: it.source === "ai" ? "var(--c-live)" : "var(--c-hand)",
          ...c,
          world: { x: r.x, y: r.y },
        },
      ];
    });
    const edges = treeEdges(items).flatMap((e) => {
      const a = centerOf(e.from);
      const b = centerOf(e.to);
      return a && b ? [{ ...e, a, b, color: colorOf(e.tag) }] : [];
    });

    const dots = order.map((tag) => {
      const g = byTag.get(tag)!;
      const b = union(g.rects)!;
      return {
        tag,
        label: tag === UNTAGGED ? "분류 없음" : tag,
        count: g.rects.length,
        color: colorOf(tag),
        cx: px(b.x + b.w / 2),
        cy: py(b.y + b.h / 2),
        r: radius(g.rects.length),
        /**
         * 이 분류를 누르면 갈 카드 (사용자 지시 2026-08-09).
         *
         * 축소 상태에서는 노드가 아니라 **분류 점**만 보이는데 그 점에는
         * 누를 것이 아예 없었다 — 학생 눈에는 "지도에서 눌러도 아무 일이
         * 없다"다. 점 하나는 트리 하나이므로 **그 트리의 뿌리**로 간다
         * (`byTag`가 seq 순서를 지키므로 첫 카드가 대화의 시작이다).
         */
        goTo: g.ids[0] ?? null,
      };
    });

    return { nodes, loose, edges, dots, scale: s, cx, cy, boxAll };
  }, [H, W, items, pan, positions, sizes, tagOrder, zoom]);

  const nodeView = zoom >= NODE_ZOOM;
  const titleView = zoom >= TITLE_ZOOM;

  /** 화면 px → world px. 노드를 끌 때 이동량을 되돌리는 데 쓴다. */
  const toWorld = useCallback(
    (d: number) => (model ? d / Math.max(1e-6, model.scale) : 0),
    [model],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    movedRef.current = false;
    const target = (e.target as HTMLElement).closest("[data-map-node]");
    if (target && model) {
      const id = target.getAttribute("data-map-node")!;
      const n =
        model.nodes.find((x) => x.id === id) ?? model.loose.find((x) => x.id === id);
      if (n) {
        nodeRef.current = { id, sx: e.clientX, sy: e.clientY, x0: n.world.x, y0: n.world.y };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        return;
      }
    }
    if (!model) return;
    panRef.current = { sx: e.clientX, sy: e.clientY, cx: model.cx, cy: model.cy };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const n = nodeRef.current;
    if (n) {
      const dx = e.clientX - n.sx;
      const dy = e.clientY - n.sy;
      if (!movedRef.current && Math.hypot(dx, dy) < DRAG_MIN) return;
      movedRef.current = true;
      // 끄는 동안에는 **그 노드만** 민다.
      const g = nodeElAt(n.id);
      if (g) {
        const bx = Number(g.dataset.bx ?? 0);
        const by = Number(g.dataset.by ?? 0);
        g.setAttribute("transform", `translate(${bx + dx},${by + dy})`);
      }
      return;
    }
    const p = panRef.current;
    if (!p || !model) return;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    if (!movedRef.current && Math.hypot(dx, dy) < DRAG_MIN) return;
    movedRef.current = true;
    // **React를 거치지 않는다** — 그룹 하나만 민다(위 contentRef 주석).
    contentRef.current?.setAttribute("transform", `translate(${dx},${dy})`);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const n = nodeRef.current;
    const p = panRef.current;
    nodeRef.current = null;
    panRef.current = null;
    if (n && movedRef.current) {
      onMoveNode(n.id, n.x0 + toWorld(e.clientX - n.sx), n.y0 + toWorld(e.clientY - n.sy));
      return;
    }
    // 끌어 옮긴 만큼을 **한 번만** state로 올린다. 올리는 순간 모델이 그
    // 자리로 다시 그려지므로 임시 transform은 같은 프레임에 걷는다.
    if (p && movedRef.current) {
      contentRef.current?.removeAttribute("transform");
      setPan({
        x: p.cx - toWorld(e.clientX - p.sx),
        y: p.cy - toWorld(e.clientY - p.sy),
      });
    }
  };

  const zoomBy = (f: number) =>
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * f)));

  if (!model) {
    return (
      <p className="text-sm" style={{ color: "var(--c-ink-faint)" }}>
        아직 지도에 그릴 것이 없어요. 캔버스에서 질문을 하나 해 보세요.
      </p>
    );
  }

  return (
    <div className="relative" style={{ width: W, height: H }}>
      <svg
        width={W}
        height={H}
        role="img"
        aria-label="대화방 지도"
        style={{ touchAction: "none", cursor: "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // 휠은 **이 상자 안에서만** 먹는다. 페이지가 함께 스크롤되면 지도
        // 확대와 브라우저 확대가 섞인다(이 화면을 따로 만든 이유 그 자체다).
        onWheel={(e) => {
          e.stopPropagation();
          zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
        }}
      >
        <defs>
          {TREE_COLORS.map((c, i) => (
            <marker
              key={c}
              id={`map-arrow-${i}`}
              viewBox="0 0 8 8"
              refX={7}
              refY={4}
              markerWidth={5}
              markerHeight={5}
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 7 4 L 0 7 z" fill={c} opacity={0.85} />
            </marker>
          ))}
        </defs>

        <g ref={contentRef}>
        {nodeView ? (
          <>
            {model.edges.map((e) => (
              <line
                key={`${e.from}->${e.to}`}
                x1={e.a.x}
                y1={e.a.y}
                x2={e.b.x}
                y2={e.b.y}
                stroke={e.color}
                strokeOpacity={0.55}
                strokeWidth={1.4}
                markerEnd={`url(#map-arrow-${TREE_COLORS.indexOf(e.color)})`}
              />
            ))}
            {model.loose.map((n) => (
              <g
                key={n.id}
                data-map-node={n.id}
                data-bx={n.x}
                data-by={n.y}
                transform={`translate(${n.x},${n.y})`}
                style={{ cursor: "grab" }}
                onClick={() => !movedRef.current && onOpen(n.id)}
              >
                <title>{`${n.title} — 눌러서 이동 · 끌어서 자리 옮기기`}</title>
                <circle r={NODE_R + 8} fill="transparent" style={{ pointerEvents: "all" }} />
                <circle
                  r={NODE_R - 1}
                  fill="var(--c-raised)"
                  stroke={n.color}
                  strokeWidth={1.4}
                  strokeOpacity={0.7}
                  strokeDasharray="2 2"
                />
                {titleView && <NodeTitle text={n.title} color="var(--c-ink-soft)" />}
              </g>
            ))}
            {model.nodes.map((n) => (
              <g
                key={n.id}
                data-map-node={n.id}
                data-bx={n.x}
                data-by={n.y}
                transform={`translate(${n.x},${n.y})`}
                style={{ cursor: "grab" }}
                onClick={() => !movedRef.current && onOpen(n.id)}
              >
                <title>{`${n.title} — 눌러서 이동 · 끌어서 자리 옮기기`}</title>
                <circle r={NODE_R + 10} fill="transparent" style={{ pointerEvents: "all" }} />
                <circle
                  r={n.root ? NODE_R + 1.5 : NODE_R}
                  fill="var(--c-raised)"
                  stroke={n.color}
                  strokeWidth={n.root ? 2.4 : 1.6}
                />
                {titleView && <NodeTitle text={n.title} color={n.color} />}
              </g>
            ))}
          </>
        ) : (
          model.dots.map((d) => (
            <g
              key={d.tag}
              transform={`translate(${d.cx},${d.cy})`}
              style={{ cursor: d.goTo ? "pointer" : "default" }}
              onClick={() => {
                if (!movedRef.current && d.goTo) onOpen(d.goTo);
              }}
            >
              <title>
                {d.goTo
                  ? `${d.label} — 글 ${d.count}개 · 눌러서 이동`
                  : `${d.label} — 글 ${d.count}개`}
              </title>
              {/* 글자·원 어디를 눌러도 잡히게 넉넉한 투명 원을 깔아 둔다. */}
              <circle r={d.r + 12} fill="transparent" style={{ pointerEvents: "all" }} />
              <circle
                r={d.r}
                fill={d.color}
                fillOpacity={0.22}
                stroke={d.color}
                strokeOpacity={0.85}
                strokeWidth={1.8}
              />
              <text
                textAnchor="middle"
                dy={4}
                style={{
                  fontFamily: "var(--font-label), monospace",
                  fontSize: 11,
                  fill: "var(--c-ink)",
                }}
              >
                {d.count}
              </text>
              <text
                textAnchor="middle"
                y={d.r + 15}
                style={{
                  fontFamily: "var(--font-label), monospace",
                  fontSize: 11,
                  fill: "var(--c-ink-soft)",
                  paintOrder: "stroke",
                  stroke: "var(--c-raised)",
                  strokeWidth: 3,
                  strokeLinejoin: "round",
                }}
              >
                {d.label}
              </text>
            </g>
          ))
        )}
        </g>
      </svg>

      {/**
       * 축척 — 상자 오른쪽 아래. 확대해야 낱개 노드가 보인다는 것을 글로도 알린다.
       *
       * ⚠️ 미니맵에서는 **더 띄워야 한다**(사용자 보고 2026-08-08: "테두리에
       * 잘린다"). 미니맵의 테두리가 3px이고 지도 상자 자체가 작아 `bottom-3`
       * 으로는 버튼이 테두리에 물린다. 좁은 상자에서만 여백을 키운다 — 팝업·
       * 페이지에서 괜히 떠 있으면 그것도 어색하다.
       */}
      <div
        data-no-pan
        className="ui absolute flex items-center gap-1 rounded-lg border px-1 py-1"
        style={{
          right: compact ? 10 : 12,
          bottom: compact ? 12 : 12,
          background: "var(--c-raised)",
          borderColor: "var(--c-rule)",
          boxShadow: "var(--c-shadow-sm)",
        }}
      >
        <MapBtn label="축소" small={compact} onClick={() => zoomBy(1 / ZOOM_STEP)}>
          <Minus size={compact ? 12 : 15} />
        </MapBtn>
        <span
          className="label text-center"
          style={{
            color: "var(--c-ink-soft)",
            fontSize: compact ? 9 : 11,
            minWidth: compact ? 30 : 44,
          }}
        >
          {Math.round(zoom * 100)}%
        </span>
        <MapBtn label="확대" small={compact} onClick={() => zoomBy(ZOOM_STEP)}>
          <Plus size={compact ? 12 : 15} />
        </MapBtn>
        <MapBtn
          label="전체 보기"
          small={compact}
          onClick={() => {
            setZoom(1);
            setPan(null);
          }}
        >
          <Maximize2 size={compact ? 11 : 14} />
        </MapBtn>
      </div>

      {!nodeView && (
        <p
          className="ui pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full"
          style={{
            top: compact ? 6 : 12,
            padding: compact ? "2px 8px" : "4px 12px",
            fontSize: compact ? 9.5 : 12,
            background: "var(--c-raised)",
            color: "var(--c-ink-soft)",
            border: "1px solid var(--c-rule)",
          }}
        >
          확대하면 글 하나하나가 보여요
        </p>
      )}
    </div>
  );
}

/** 노드 아래 제목. 확대했을 때만 붙는다. */
function NodeTitle({ text, color }: { text: string; color: string }) {
  if (!text) return null;
  return (
    <text
      textAnchor="middle"
      y={NODE_R + 14}
      style={{
        fontFamily: "var(--font-label), monospace",
        fontSize: 10.5,
        fill: color,
        // 선 위에 글자가 얹혀도 읽히도록 종이색으로 한 번 두른다.
        paintOrder: "stroke",
        stroke: "var(--c-raised)",
        strokeWidth: 3.5,
        strokeLinejoin: "round",
        pointerEvents: "none",
      }}
    >
      {text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text}
    </text>
  );
}

function MapBtn({
  label,
  onClick,
  children,
  small = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  /** 미니맵에서는 손가락이 아니라 마우스로 누른다 — 작아도 된다 (D211 7). */
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex items-center justify-center rounded transition-colors"
      style={{
        color: "var(--c-ink-soft)",
        width: small ? 20 : 28,
        height: small ? 20 : 28,
      }}
    >
      {children}
    </button>
  );
}
