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
import { buildTrees, treeEdges, descendants, LOOSE_TAG } from "@/lib/canvas2/tree";
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
/**
 * 잡는 자리의 반지름 (2026-08-11).
 *
 * 손가락은 마우스보다 뭉툭하다 — 접촉면이 대략 지름 9mm이고, 화면에서
 * 44px(애플·구글이 함께 권하는 최소 터치 목표)에 해당한다. 보이는 점은
 * 그대로 두고 **투명한 히트 원만** 키운다.
 */
const HIT_R =
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches
    ? 22
    : NODE_R + 8;
/**
 * 계층은 **화면 배율**로 가른다 (사용자 보고 2026-08-11).
 *
 * 예전에는 `zoom`으로 갈랐다(1.8 / 2.6). `zoom`은 1에서 시작하므로 지도는
 * **어느 크기로 열든 언제나 태그 점**이었다 — 미니맵이든 전체 화면이든.
 * 그런데 점에는 `data-map-node`가 없어서 끌기가 아예 안 잡히고, 누르면 그
 * 태그의 대표 항목으로 간다. 전체 화면으로 크게 펼쳐 놓고도 **노드를 누르거나
 * 옮길 방법이 없었다.**
 *
 * `model.scale`(= 상자에 맞춘 배율 × zoom)은 "화면에서 얼마나 크게 그려지나"를
 * 그대로 말한다 — 상자 크기가 이미 들어 있다. 그 값으로 가르면 규칙 하나가
 * 셋을 옳게 다룬다: 좁은 미니맵은 점, 넓은 팝업·페이지는 노드.
 *
 * ## 잣대는 `model.scale`이 **아니다**
 *
 * 처음에는 화면 배율(`fit × zoom`)로 갈랐다. 그런데 그 값은 **내용 경계**에
 * 딸려 있다 — 학생이 노드를 멀리 끌면 경계가 커지고 `fit`이 떨어져, 자기가
 * 끈 그 동작 때문에 지도가 점으로 되돌아갔다(실측 2026-08-11: 팝업에서
 * 한 번 끌었더니 노드가 통째로 사라졌다). 화면이 자기 조작에 뒤집히면
 * 그건 규칙이 아니라 고장으로 읽힌다.
 *
 * 그래서 **노드 하나가 갖는 화면 면적**으로 가른다:
 *
 *     여유 = 상자넓이 × 상자높이 × zoom² ÷ 노드 수
 *
 * 이 값은 상자 크기·배율·노드 수로만 정해져 **끌어도 안 변한다.** 계층이
 * 원래 막으려던 것(빽빽해서 글자가 뭉개지는 것)도 그대로 지켜진다 — 그것은
 * 애초에 "한 노드에 자리가 얼마나 있나"의 문제였다.
 *
 * 값은 실측에서 왔다(2026-08-11, 1440×900, 노드 3):
 *   · 미니맵 258×168 → 여유 14,400 (점)
 *   · 같은 내용이 팝업 1041×666 → 여유 **231,000** (노드)
 *   · 미니맵을 옛 경계(zoom 1.8)까지 확대하면 46,800 — 그래서 45,000을 쓰면
 *     미니맵의 거동이 종전과 같다.
 *   · 팝업이라도 노드 150개면 4,600이라 점으로 남는다.
 */
const NODE_ROOM = 45_000;
/** 이만큼 여유가 있으면 노드 **제목**도 붙는다 (옛 zoom 2.6 = 97,700). */
const TITLE_ROOM = 95_000;
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
  const nodeRef = useRef<{
    id: string;
    /** 함께 움직일 것들 — 자기와 자손 (D154·D161과 같은 규칙). */
    ids: string[];
    sx: number;
    sy: number;
    x0: number;
    y0: number;
  } | null>(null);
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

  /** 노드 하나가 갖는 화면 면적 — 계층을 가르는 잣대(위 머리말). */
  const 여유 = model
    ? (W * H * zoom * zoom) / Math.max(1, model.nodes.length + model.loose.length)
    : 0;
  const nodeView = 여유 >= NODE_ROOM;
  const titleView = 여유 >= TITLE_ROOM;

  /** 화면 px → world px. 노드를 끌 때 이동량을 되돌리는 데 쓴다. */
  const toWorld = useCallback(
    (d: number) => (model ? d / Math.max(1e-6, model.scale) : 0),
    [model],
  );

  /**
   * 누른 것이 무엇이었나 — **`pointerup`에서 판정한다** (사용자 보고 2026-08-11).
   *
   * ⚠️ 예전에는 노드·점에 `onClick`을 달았다. 그런데 아래에서
   * `setPointerCapture`를 svg에 걸므로, 브라우저는 `click`을 **캡처한
   * 요소**에 준다 — 노드의 `onClick`은 영영 안 불린다. 실측 2026-08-11:
   * 팝업에서 노드를 눌러도 카메라가 그대로였고 지도도 안 닫혔다.
   * 누르기와 끌기가 **같은 제스처의 두 끝**이므로 판정도 한 곳에서 한다.
   */
  const tapRef = useRef<string | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    movedRef.current = false;
    tapRef.current = null;
    const el = e.target as HTMLElement;
    const target = el.closest("[data-map-node]");
    if (target && model) {
      const id = target.getAttribute("data-map-node")!;
      const n =
        model.nodes.find((x) => x.id === id) ?? model.loose.find((x) => x.id === id);
      if (n) {
        // 가지가 함께 간다 — 놓았을 때만 따라오면 끄는 동안 선이 늘어난다.
        const ids = [id, ...descendants(items, id)];
        nodeRef.current = { id, ids, sx: e.clientX, sy: e.clientY, x0: n.world.x, y0: n.world.y };
        tapRef.current = id;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        return;
      }
    }
    // 태그 점도 누르면 그 트리로 간다. 점은 끌 수 없으므로 표시만 남긴다.
    const dot = el.closest("[data-map-dot]");
    if (dot) tapRef.current = dot.getAttribute("data-map-dot");
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
      /**
       * 끄는 동안 **가지와 연결선이 함께 간다** (사용자 지시 2026-08-11).
       *
       * 예전에는 그 노드 하나만 밀었다. 자식은 제자리에 남고 선은 원래 두
       * 점을 잇고 있으니, 끄는 내내 노드가 자기 선에서 떨어져 나갔다 —
       * 놓는 순간 전부 제자리를 찾으므로 "어색하다"로만 보인다.
       *
       * React를 거치지 않는 이유는 노드 하나를 밀 때와 같다(위 `contentRef`
       * 머리말) — 매 프레임 지도를 다시 세우면 손보다 늦다.
       */
      for (const mid of n.ids) {
        const g = nodeElAt(mid);
        if (!g) continue;
        const bx = Number(g.dataset.bx ?? 0);
        const by = Number(g.dataset.by ?? 0);
        g.setAttribute("transform", `translate(${bx + dx},${by + dy})`);
      }
      const 움직이는 = new Set(n.ids);
      for (const line of document.querySelectorAll<SVGLineElement>("[data-map-edge]")) {
        const from = line.dataset.from ?? "";
        const to = line.dataset.to ?? "";
        if (!움직이는.has(from) && !움직이는.has(to)) continue;
        // 원래 좌표는 data-*에 적어 둔다 — 고친 값을 다시 읽으면 누적된다.
        const ax = Number(line.dataset.ax ?? 0);
        const ay = Number(line.dataset.ay ?? 0);
        const bx2 = Number(line.dataset.bx2 ?? 0);
        const by2 = Number(line.dataset.by2 ?? 0);
        line.setAttribute("x1", String(움직이는.has(from) ? ax + dx : ax));
        line.setAttribute("y1", String(움직이는.has(from) ? ay + dy : ay));
        line.setAttribute("x2", String(움직이는.has(to) ? bx2 + dx : bx2));
        line.setAttribute("y2", String(움직이는.has(to) ? by2 + dy : by2));
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
      tapRef.current = null;
      return;
    }
    // 움직이지 않았으면 **누른 것**이다 — 그 노드로 간다(위 `tapRef` 머리말).
    if (!movedRef.current && tapRef.current) {
      const id = tapRef.current;
      tapRef.current = null;
      onOpen(id);
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
        /* 계층을 가르는 값들. 시험이 눈이 아니라 숫자로 확인할 수 있어야
           한다(`data-strokes`와 같은 태도). */
        data-map-scale={model ? model.scale : 0}
        data-map-room={Math.round(여유)}
        data-map-nodes={model ? model.nodes.length + model.loose.length : 0}
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
                /* 끌 때 손으로 옮기는 대상 — 원래 좌표를 함께 적어 둔다
                   (고친 값을 다시 읽으면 이동량이 누적된다). */
                data-map-edge
                data-from={e.from}
                data-to={e.to}
                data-ax={e.a.x}
                data-ay={e.a.y}
                data-bx2={e.b.x}
                data-by2={e.b.y}
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
              >
                <title>{`${n.title} — 눌러서 이동 · 끌어서 자리 옮기기`}</title>
                {/* 손가락은 마우스보다 뭉툭하다 — coarse 포인터에서는 잡는
                    자리를 키운다(보이는 점은 그대로). */}
                <circle r={HIT_R} fill="transparent" style={{ pointerEvents: "all" }} />
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
              data-map-dot={d.goTo ?? undefined}
              transform={`translate(${d.cx},${d.cy})`}
              style={{ cursor: d.goTo ? "pointer" : "default" }}
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
