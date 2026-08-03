"use client";

/**
 * 개념 지도 — 축척에 따라 **두 가지를 보여 준다** (D139 → D151).
 *
 * ```
 *   축소  태그 하나 = 점 하나          "무엇이 어디에 있나"
 *   확대  노드 하나 = 점 하나 + 방향선  "무엇에서 무엇이 나왔나"
 * ```
 *
 * ## 왜 축척으로 가르나
 *
 * 둘 다 필요한데 한 화면에 같이 두면 못 쓴다. 글이 20개면 노드 20개 + 선
 * 19개가 340×250 안에 들어가고, 그 위에 태그 점까지 겹치면 아무것도 안 읽힌다.
 * 예전에 "아이템마다 사각형"으로 그렸다가 사용자에게 정확히 그 지적을 받았다
 * ("겹치는 부분이 많아서 오히려 보기 힘들다").
 *
 * 축척은 **무엇을 묻고 있는지**를 나눈다. 멀리서 보면 "어느 주제가 어디쯤"이
 * 궁금하고, 당겨 보면 "이 주제가 어떻게 뻗어 나갔나"가 궁금하다.
 *
 * ## 확대하면 중심이 바뀐다
 *
 * 축소 상태에서는 전체를 담고, 확대하면 **지금 보고 있는 영역**을 중심에 둔다.
 * 전체 중심에 고정한 채 확대하면 캔버스 한쪽 끝에서 작업 중일 때 지도가 엉뚱한
 * 곳을 크게 보여 준다.
 *
 * ## 선은 지도의 것이다
 *
 * 트리 간선은 원래 지도에서만 보이는 선이다(사용자 지시 2026-08-02). 다만
 * 캔버스에도 겹쳐 볼 수 있게 토글을 둔다 — **기본은 켬**. ConnectorLayer가
 * 같은 저장 키를 보므로 둘은 어긋날 수 없다.
 */

import { useMemo, useRef, useState } from "react";
import { Link2, Link2Off, Map as MapIcon, Minus, Plus, X } from "lucide-react";
import { ITEM_W, UNTAGGED, type Placed } from "@/lib/canvas2/layout";
import type { Rect } from "@/lib/canvas2/rect";
import { union } from "@/lib/canvas2/rect";
import type { Size } from "@/lib/canvas2/useItemLayout";
import type { Camera, CanvasItem } from "@/lib/canvas2/types";
import { buildTrees, treeEdges } from "@/lib/canvas2/tree";
import { useCollapsible } from "@/lib/canvas2/useCollapsible";

/** 펼쳤을 때 크기. 점과 라벨이 겹치지 않으려면 이만큼은 필요하다(v1과 같은 값). */
const W = 340;
const H = 250;
/** 가장자리 여백 — 점 반지름(≤24)과 라벨이 잘리지 않을 만큼. */
const PAD = 46;

/** 점 반지름 = clamp(BASE + √count × GROWTH). 글이 많은 태그일수록 큰 점. */
const R_MIN = 7;
const R_MAX = 24;
const R_BASE = 7;
const R_GROWTH = 3.2;

/** 라벨은 이 길이에서 자른다. */
const LABEL_MAX = 9;
/** 라벨 글자 하나의 대략 폭(px). 한글은 폰트 크기와 거의 같다. */
const LABEL_CH = 9.5;
/** 점 아래 라벨이 차지하는 높이(px). */
const LABEL_H = 16;

/**
 * 이 배율부터 노드 지도로 바뀐다.
 *
 * 1.8이면 화면에 담기던 것이 대략 세 배 면적으로 퍼진다 — 노드 스무 개가
 * 서로 떨어져 찍히기 시작하는 지점이다(그보다 낮으면 점이 붙어 선이 안 읽힌다).
 */
const NODE_ZOOM = 1.8;
const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const ZOOM_STEP = 1.35;

/** 노드 지도의 점 반지름. */
const NODE_R = 4.5;

/**
 * 트리 색. 태그 순서대로 돌려 쓴다.
 *
 * 트리가 여럿일 때 **선이 어느 트리 것인지**가 색으로 갈려야 마인드맵으로
 * 읽힌다. 캔버스 본문의 오커/틸과 부딪히지 않게 채도를 낮춰 골랐다.
 */
const TREE_COLORS = [
  "#b4692a",
  "#2f7d76",
  "#5a5fa8",
  "#8a5a86",
  "#4d7a3a",
  "#a05252",
];

const COLLAPSE_BELOW = 1024;
const RIGHT = 16;
const TOP = 16;
const FALLBACK: Size = { w: ITEM_W, h: 180 };

function radius(count: number): number {
  return Math.max(R_MIN, Math.min(R_MAX, R_BASE + Math.sqrt(count) * R_GROWTH));
}

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  sizes: Map<string, Size>;
  /** 태그 순서(첫 등장). */
  tagOrder: readonly string[];
  camera: Camera;
  viewport: { w: number; h: number };
  /** 지금 이어 묻고 있는 트리 노드 (D151). 지도에서도 또렷해야 한다. */
  pickedId: string | null;
  /**
   * 이 사각형이 **화면에 크게 담기도록** 이동한다 (D155, 사용자 지시:
   * "그 노드가 화면에 엄청 크게 보이도록 확대해서 이동").
   */
  onFocus: (rect: Rect) => void;
}

export function Minimap({
  items,
  positions,
  sizes,
  tagOrder,
  camera,
  viewport,
  pickedId,
  onFocus,
}: Props) {
  // 학생이 접어 두면 **접힌 채로 남는다**(D140). 처음 방문은 화면 폭으로 정한다.
  const { open, setOpen } = useCollapsible("map", viewport.w >= COLLAPSE_BELOW);
  // 캔버스에도 트리 선을 그릴 것인가 — ConnectorLayer가 같은 키를 본다.
  const { open: edgesOnCanvas, setOpen: setEdgesOnCanvas } = useCollapsible(
    "canvas-edges",
    true,
  );
  const [zoom, setZoom] = useState(1);
  /**
   * 학생이 끌어 옮긴 지도 중심(world). null이면 내용 전체를 담는다 (D155).
   *
   * 지도를 캔버스에 묶어 두면 "지금 보는 곳" 밖은 볼 수가 없다(사용자 지시
   * 2026-08-02: "마우스 클릭 드래그로 지도를 자유롭게 이동"). 축척을 끝까지
   * 되돌리면 다시 전체 보기로 돌아간다.
   */
  const [pan, setPan] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  /**
   * 끄는 동안 내용을 담는 그룹 — **React를 거치지 않고 여기만 민다** (D158).
   *
   * 예전에는 pointermove마다 `setPan`을 불러 지도 전체를 다시 계산했다.
   * 트리·간선·점 분리까지 매 프레임 다시 도니 손보다 늦게 따라왔다(사용자
   * 지적 2026-08-03: "지도에서 드래그를 할 때 노드들이 뒤늦게 따라가는
   * 딜레이"). 지도를 끄는 것은 **화면 좌표를 그대로 평행이동**하는 것과
   * 같으므로 transform 하나로 정확히 같은 결과가 나온다 — 캔버스 팬에서
   * 쓰는 방법과 같다(D124).
   *
   * 손을 뗄 때 한 번만 state로 올린다.
   */
  const contentRef = useRef<SVGGElement>(null);
  /**
   * 방금 포인터 동작이 **끌기였나**.
   *
   * `dragRef`로 판정하면 안 된다 — `pointerup`이 `click`보다 먼저 돌아 그때
   * 이미 비워져 있다. 그러면 지도를 끌어 옮기고 손을 뗀 자리에 노드가 있을 때
   * 화면이 엉뚱한 데로 튄다.
   */
  const movedRef = useRef(false);
  const nodeView = zoom >= NODE_ZOOM;

  const model = useMemo(() => {
    /** 태그 → 그 태그 글들의 사각형. */
    const byTag = new Map<string, { rects: Rect[]; ai: number }>();
    for (const it of items) {
      const p = positions.get(it.id);
      if (!p) continue;
      const s = sizes.get(it.id) ?? FALLBACK;
      const tag = it.tag || UNTAGGED;
      const cur = byTag.get(tag) ?? { rects: [], ai: 0 };
      cur.rects.push({ x: p.x, y: p.y, w: s.w, h: s.h });
      if (it.source === "ai") cur.ai++;
      byTag.set(tag, cur);
    }
    if (!byTag.size) return null;

    const order = [...tagOrder, ...byTag.keys()].filter(
      (t, i, a) => a.indexOf(t) === i && byTag.has(t),
    );
    const colorOf = (tag: string) =>
      TREE_COLORS[Math.max(0, order.indexOf(tag)) % TREE_COLORS.length];

    // 태그 하나당 점 하나. 자리는 그 태그가 차지한 영역의 중심이다.
    const dots = order.map((tag) => {
      const g = byTag.get(tag)!;
      const b = union(g.rects)!;
      return {
        tag,
        label: tag === UNTAGGED ? "분류 없음" : tag,
        count: g.rects.length,
        aiRatio: g.ai / g.rects.length,
        wx: b.x + b.w / 2,
        wy: b.y + b.h / 2,
        // 눌렀을 때 이 태그 전체가 화면에 담기게 (D155).
        rect: b,
      };
    });

    // 지금 보고 있는 영역(world). world = screen/zoom - scroll
    const view: Rect = {
      x: -camera.scrollX,
      y: -camera.scrollY,
      w: viewport.w / camera.zoom,
      h: viewport.h / camera.zoom,
    };

    /**
     * 담을 범위는 **글 사각형 전부**다 (D155).
     *
     * 점(태그 중심)만으로 잡으면 태그가 하나일 때 범위가 **점 하나로
     * 줄어들어** 축척이 폭발한다(실측: 세 노드가 ±6만px로 흩어졌다).
     * 사각형은 크기가 있으므로 하나만 있어도 범위가 성립한다.
     *
     * 예전에는 뷰포트(view)까지 union에 넣었다. 그러면 캔버스를 움직일 때마다
     * 범위가 달라져 **축척과 중심이 같이 흔들리고 지도의 점들이 스르르
     * 움직인다** — 사용자가 지적한 "노드들의 위치가 느리게 변하는 딜레이
     * 현상"이 이것이다. 게다가 카메라 상태는 멈춘 뒤에야 React로 올라오므로
     * (D124) 그 흔들림이 한 박자 늦게 온다.
     *
     * 내용만 보면 캔버스를 아무리 움직여도 지도의 점은 제자리다.
     */
    const box = union([...byTag.values()].flatMap((g) => g.rects))!;

    // **양축에 같은 배율**을 쓴다 — 다르게 주면 실제로 나란한 열이 지도에서
    // 비스듬해 보여 공간 정보가 거짓이 된다.
    const fit = Math.min(
      (W - PAD * 2) / Math.max(1, box.w),
      (H - PAD * 2) / Math.max(1, box.h),
    );
    const s = fit * zoom;
    // **지도는 캔버스를 따라가지 않는다** (D155). 학생이 끌어 옮긴 자리가
    // 있으면 그것이 중심이고, 없으면 내용 전체의 중심이다.
    const cx = pan ? pan.x : box.x + box.w / 2;
    const cy = pan ? pan.y : box.y + box.h / 2;
    const px = (x: number) => W / 2 + (x - cx) * s;
    const py = (y: number) => H / 2 + (y - cy) * s;

    // --- 노드 지도 (확대 상태) ---------------------------------------------
    const trees = buildTrees(items);
    const depthOf = new Map<string, number>();
    for (const t of trees) for (const [id, d] of t.depth) depthOf.set(id, d);
    const center = (id: string) => {
      const p = positions.get(id);
      if (!p) return null;
      const sz = sizes.get(id) ?? FALLBACK;
      return { x: px(p.x + sz.w / 2), y: py(p.y + sz.h / 2) };
    };
    const nodes = trees.flatMap((t) =>
      t.order.flatMap((id) => {
        const c = center(id);
        if (!c) return [];
        const it = items.find((i) => i.id === id);
        return [
          {
            id,
            tag: t.tag,
            label: it?.title?.trim() || it?.body.slice(0, 20) || "",
            root: (depthOf.get(id) ?? 0) === 0,
            color: colorOf(t.tag),
            ...c,
            // 클릭 이동은 축소된 자리가 아니라 **원래 world 사각형**으로 한다.
            rect: {
              x: positions.get(id)?.x ?? 0,
              y: positions.get(id)?.y ?? 0,
              w: sizes.get(id)?.w ?? FALLBACK.w,
              h: sizes.get(id)?.h ?? FALLBACK.h,
            },
          },
        ];
      }),
    );
    const edges = treeEdges(items).flatMap((e) => {
      const a = center(e.from);
      const b = center(e.to);
      return a && b ? [{ ...e, a, b, color: colorOf(e.tag) }] : [];
    });

    /**
     * 트리에 안 들어가는 글 — 학생 메모·도판·분류 없는 글.
     *
     * 안 그리면 **지도가 통째로 빈다.** 메모만 있는 세션을 확대하면 흰 판이
     * 뜬다(실측). 캔버스에 분명히 있는 것이 지도에서 사라지면 지도가 거짓말을
     * 하는 셈이다. 선은 없고 점만, 속을 비워서 트리 노드와 구별한다.
     */
    const treeIds = new Set(nodes.map((n) => n.id));
    const loose = items.flatMap((it) => {
      if (treeIds.has(it.id)) return [];
      const c = center(it.id);
      if (!c) return [];
      return [
        {
          id: it.id,
          ...c,
          color: it.source === "ai" ? "var(--c-live)" : "var(--c-hand)",
          rect: {
            x: positions.get(it.id)?.x ?? 0,
            y: positions.get(it.id)?.y ?? 0,
            w: sizes.get(it.id)?.w ?? FALLBACK.w,
            h: sizes.get(it.id)?.h ?? FALLBACK.h,
          },
        },
      ];
    });

    /**
     * 점이 겹치면 살짝 밀어 떼어 놓는다.
     *
     * 클러스터가 실제로 공간에서 겹칠 수 있다 — 특히 "분류 없음"은 학생이
     * 여기저기 끌어다 둔 메모라 중심이 다른 열 위에 얹힌다. 위치를 그대로
     * 두면 두 점이 포개져 **읽을 수 없다**(사용자 지적: "겹치는 부분이 많아서
     * 오히려 보기 힘들다").
     *
     * 원래 자리에서 조금씩만 밀므로 공간 정보는 거의 그대로다. 클릭 시 이동은
     * 밀린 좌표가 아니라 **원래 world 좌표**(`wx`,`wy`)로 하므로 정확하다.
     */
    const placed = dots.map((d) => {
      const r = radius(d.count);
      const text = d.label.length > LABEL_MAX ? LABEL_MAX + 1 : d.label.length;
      return {
        ...d,
        cx: px(d.wx),
        cy: py(d.wy),
        r,
        color: colorOf(d.tag),
        // **라벨까지 포함한 반폭·반높이.** 원만 떼어 놓으면 이름끼리 겹친다
        // (실측: 점은 안 겹치는데 "지구과학"과 "상태"가 포개졌다). 한글은
        // 폰트 크기와 글자 폭이 거의 같아 글자 수 × LABEL_CH로 잡는다.
        hw: Math.max(r, (text * LABEL_CH) / 2),
        hh: r + LABEL_H,
      };
    });
    const GAP = 4;
    for (let pass = 0; pass < 40; pass++) {
      let moved = false;
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i];
          const b = placed[j];
          const dx = b.cx - a.cx;
          const dy = b.cy - a.cy;
          const ox = a.hw + b.hw + GAP - Math.abs(dx);
          const oy = a.hh + b.hh + GAP - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue; // 어느 한 축이라도 벌어져 있으면 안 겹친다
          moved = true;
          // **덜 밀어도 되는 축**으로 가른다 — 원래 자리에서 최소한만 벗어난다.
          if (ox < oy) {
            const s2 = (dx >= 0 ? 1 : -1) * (ox / 2);
            a.cx -= s2;
            b.cx += s2;
          } else {
            const s2 = (dy >= 0 ? 1 : -1) * (oy / 2);
            a.cy -= s2;
            b.cy += s2;
          }
        }
      }
      if (!moved) break;
    }
    // 민 뒤에 화폭을 벗어날 수 있다 — 라벨까지 들어오게 가둔다. 확대 상태에서는
    // 가두지 않는다(밖으로 나간 것은 클리핑이 잘라 낸다 — 그게 확대의 뜻이다).
    if (zoom === 1) {
      for (const d of placed) {
        d.cx = Math.min(W - d.hw - 2, Math.max(d.hw + 2, d.cx));
        d.cy = Math.min(H - d.hh - 2, Math.max(d.r + 6, d.cy));
      }
    }

    const viewRect = { x: px(view.x), y: py(view.y), w: view.w * s, h: view.h * s };
    return {
      dots: placed,
      nodes,
      edges,
      loose,
      /** 화면 px ↔ world 환산. 끌어서 옮길 때 쓴다. */
      scale: s,
      center: { x: cx, y: cy },
      view: viewRect,
      /**
       * 보기 영역 사각형이 지도 안에 들어오나.
       *
       * 지도를 확대하면 **이 사각형도 같이 커진다** — 기하적으로는 맞지만
       * 지도를 넘어서는 순간 정보가 아니라 회색 판이 된다. 실측: 1.8배(노드
       * 연결로 바뀌는 지점)에서 이미 288px로 지도 높이 250을 넘고, 3.3배면
       * 461×525로 지도를 통째로 덮어 트리가 안 보인다(사용자 지적
       * 2026-08-02: "지도를 확대할 때 화면까지 같이 확대된다").
       *
       * 넘어섰다는 것은 "지도에 보이는 게 전부 화면 안에 있다"는 뜻이라
       * 애초에 가리킬 것이 없다. 그럴 때는 그리지 않는다.
       */
      viewFits: viewRect.w <= W && viewRect.h <= H,
    };
  }, [items, positions, sizes, tagOrder, camera, viewport, zoom, pan]);

  if (!model) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-no-pan
        onClick={() => setOpen(true)}
        aria-label="개념 지도 열기"
        title="개념 지도"
        className="ui absolute z-30 flex h-9 w-9 items-center justify-center rounded-lg border transition-colors"
        style={{
          right: RIGHT,
          top: TOP,
          background: "var(--c-raised)",
          borderColor: "var(--c-rule)",
          color: "var(--c-ink-soft)",
          boxShadow: "var(--c-shadow-sm)",
        }}
      >
        <MapIcon size={16} />
      </button>
    );
  }

  const zoomBy = (f: number) =>
    setZoom((z) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * f));
      // 끝까지 되돌리면 전체 보기로 — 끌어 둔 자리를 놓는다.
      if (next === ZOOM_MIN) setPan(null);
      return next;
    });

  /** 지도를 끌어 옮긴다 (D155). 화면 px를 world로 환산해 중심을 반대로 민다. */
  const onPanStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    movedRef.current = false;
    dragRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      cx: model.center.x,
      cy: model.center.y,
    };
    // **여기서 포인터를 잡지 않는다.** 캡처하면 뒤따르는 click의 대상이
    // 잡은 요소(svg)로 바뀌어 **노드 클릭이 통째로 죽는다**(실측: 눌러도
    // 화면이 안 움직였다). 실제로 끌기 시작한 뒤에 잡는다.
  };
  const onPanMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!movedRef.current && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) {
      movedRef.current = true;
      // 이제부터는 지도 밖으로 나가도 계속 끌 수 있게 잡는다.
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    }
    if (!movedRef.current) return; // 아직 클릭일 수 있다 — 화면을 흔들지 않는다
    const g = contentRef.current;
    if (g) g.style.transform = `translate(${e.clientX - d.sx}px, ${e.clientY - d.sy}px)`;
  };
  const onPanEnd = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !movedRef.current) return;
    // 화면 이동량을 world로 환산해 한 번만 올린다. 다음 렌더가 같은 자리를
    // 그리므로 여기서 transform을 지워도 튀지 않는다.
    setPan({
      x: d.cx - (e.clientX - d.sx) / model.scale,
      y: d.cy - (e.clientY - d.sy) / model.scale,
    });
    const g = contentRef.current;
    if (g) g.style.transform = "";
  };
  /** 끌어 옮긴 동작이었으면 클릭으로 치지 않는다. */
  const dragged = () => movedRef.current;

  return (
    <div
      data-no-pan
      // 오른쪽 위 — 사용자 지시. 도구 레일은 피한다.
      className="ui absolute z-30 overflow-hidden rounded-lg border"
      style={{
        right: RIGHT,
        top: TOP,
        background: "var(--c-raised)",
        borderColor: "var(--c-rule)",
        boxShadow: "var(--c-shadow-md)",
      }}
    >
      {/* 조작 줄 — 축척과 선 토글. 축척이 무엇을 바꾸는지도 여기서 알린다. */}
      <div
        className="flex items-center gap-1 border-b px-1.5 py-1"
        style={{ borderColor: "var(--c-rule)" }}
      >
        <MapBtn label="지도 축소" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}>
          <Minus size={12} />
        </MapBtn>
        <MapBtn label="지도 확대" onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}>
          <Plus size={12} />
        </MapBtn>
        <span
          className="label ml-0.5 select-none truncate"
          style={{ color: "var(--c-ink-faint)", letterSpacing: 0 }}
        >
          {nodeView ? "노드 연결" : "태그 묶음"}
        </span>
        <div className="flex-1" />
        <MapBtn
          label={edgesOnCanvas ? "캔버스의 선 숨기기" : "캔버스에도 선 보이게 하기"}
          onClick={() => setEdgesOnCanvas(!edgesOnCanvas)}
          on={edgesOnCanvas}
        >
          {edgesOnCanvas ? <Link2 size={12} /> : <Link2Off size={12} />}
        </MapBtn>
        <MapBtn label="개념 지도 닫기" onClick={() => setOpen(false)}>
          <X size={12} />
        </MapBtn>
      </div>

      <svg
        width={W}
        height={H}
        className="block"
        aria-label="개념 지도"
        style={{ cursor: "grab", touchAction: "none" }}
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
        onWheel={(e) => {
          // 지도 위 휠은 지도의 축척이다 — 캔버스로 넘기지 않는다.
          e.stopPropagation();
          zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
        }}
      >
        <defs>
          <clipPath id="c2-map-clip">
            <rect x={0} y={0} width={W} height={H} />
          </clipPath>
          {TREE_COLORS.map((c, i) => (
            <marker
              key={i}
              id={`c2-arrow-${i}`}
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

        <g clipPath="url(#c2-map-clip)">
          <g ref={contentRef}>
          {/* 지금 보고 있는 영역. 점보다 뒤에 옅게 — 정보는 점이 준다.
              지도를 확대해 이 사각형이 지도를 넘어서면 그리지 않는다(위 주석). */}
          {model.viewFits && (
            <rect
              x={model.view.x}
              y={model.view.y}
              width={Math.max(4, model.view.w)}
              height={Math.max(4, model.view.h)}
              rx={3}
              fill="var(--c-ink)"
              fillOpacity={0.04}
              stroke="var(--c-ink)"
              strokeOpacity={0.35}
              strokeWidth={1}
            />
          )}

          {nodeView ? (
            <>
              {/* 방향 그래프 — 부모에서 자식으로. 화살촉이 방향을 말한다. */}
              {model.edges.map((e) => (
                <line
                  key={`${e.from}->${e.to}`}
                  x1={e.a.x}
                  y1={e.a.y}
                  x2={e.b.x}
                  y2={e.b.y}
                  stroke={e.color}
                  strokeOpacity={0.55}
                  strokeWidth={1.2}
                  markerEnd={`url(#c2-arrow-${TREE_COLORS.indexOf(e.color)})`}
                />
              ))}
              {/* 트리 밖 글(메모·도판) — 선 없이 점만. 속을 비우고 점선으로
                  둘러 트리 노드와 구별한다. 안 그리면 메모뿐인 세션에서
                  지도가 통째로 빈다. */}
              {model.loose.map((n) => (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  style={{ cursor: "pointer" }}
                  onClick={() => !dragged() && onFocus(n.rect)}
                >
                  <circle r={NODE_R + 6} fill="transparent" style={{ pointerEvents: "all" }} />
                  <circle
                    r={NODE_R - 1}
                    fill="var(--c-raised)"
                    stroke={n.color}
                    strokeWidth={1.2}
                    strokeOpacity={0.6}
                    strokeDasharray="2 2"
                  />
                </g>
              ))}
              {model.nodes.map((n) => (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  style={{ cursor: "pointer" }}
                  onClick={() => !dragged() && onFocus(n.rect)}
                >
                  <title>{`${n.label} — 눌러서 이동`}</title>
                  <circle r={NODE_R + 8} fill="transparent" style={{ pointerEvents: "all" }} />
                  <circle
                    r={n.id === pickedId ? NODE_R + 2.5 : n.root ? NODE_R + 1 : NODE_R}
                    fill={n.id === pickedId ? n.color : "var(--c-raised)"}
                    stroke={n.color}
                    strokeWidth={n.root ? 2 : 1.4}
                    strokeOpacity={0.9}
                  />
                </g>
              ))}
              {/* 이름은 뿌리에만 — 노드마다 달면 글자가 선을 덮는다. */}
              {model.nodes
                .filter((n) => n.root && n.tag !== UNTAGGED)
                .map((n) => (
                  <text
                    key={`l-${n.id}`}
                    x={n.x}
                    y={n.y - NODE_R - 6}
                    textAnchor="middle"
                    style={{
                      fontFamily: "var(--font-label), monospace",
                      fontSize: 9.5,
                      fill: n.color,
                      paintOrder: "stroke",
                      stroke: "var(--c-raised)",
                      strokeWidth: 3,
                      strokeLinejoin: "round",
                    }}
                  >
                    {n.tag.length > LABEL_MAX ? `${n.tag.slice(0, LABEL_MAX)}…` : n.tag}
                  </text>
                ))}
            </>
          ) : (
            model.dots.map((d) => (
              <g
                key={d.tag}
                transform={`translate(${d.cx},${d.cy})`}
                style={{ cursor: "pointer" }}
                onClick={() => !dragged() && onFocus(d.rect)}
              >
                <title>{`${d.label} — 글 ${d.count}개. 눌러서 이동`}</title>
                {/* **보이지 않는 클릭 영역.**
                    SVG는 그려진 부분만 히트 테스트한다. 점과 아래 라벨 사이의 빈
                    틈을 누르면 아무것도 안 잡혀 이동이 안 됐다(실측: 카메라가
                    15px만 움직임). 점+라벨을 함께 덮는 원을 깔아 둔다 —
                    `fill="none"`은 안 잡히므로 투명 채움 + pointerEvents가 필요하다. */}
                <circle r={d.r + 16} fill="transparent" style={{ pointerEvents: "all" }} />
                {/* 색은 트리(태그), 크기는 글 수 */}
                <circle
                  r={d.r}
                  fill={d.color}
                  fillOpacity={0.22}
                  stroke={d.color}
                  strokeOpacity={0.8}
                  strokeWidth={1.5}
                />
                <text
                  textAnchor="middle"
                  dy={4}
                  style={{
                    fontFamily: "var(--font-label), monospace",
                    fontSize: 10,
                    fill: "var(--c-ink)",
                  }}
                >
                  {d.count}
                </text>
                {/* 라벨은 점 **아래**에 둔다. 옆에 두면 열이 촘촘할 때 이웃 점을 덮는다.
                    종이색 외곽선을 깔아 점 위로 지나가도 글자가 읽히게 한다. */}
                <text
                  textAnchor="middle"
                  y={d.r + 12}
                  style={{
                    fontFamily: "var(--font-label), monospace",
                    fontSize: 9.5,
                    fill: "var(--c-ink-soft)",
                    paintOrder: "stroke",
                    stroke: "var(--c-raised)",
                    strokeWidth: 3,
                    strokeLinejoin: "round",
                  }}
                >
                  {d.label.length > LABEL_MAX ? `${d.label.slice(0, LABEL_MAX)}…` : d.label}
                </text>
              </g>
            ))
          )}
          </g>
        </g>
      </svg>
    </div>
  );
}

function MapBtn({
  label,
  onClick,
  disabled,
  on,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  on?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={on}
      title={label}
      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--c-sunk)] disabled:opacity-30"
      style={{
        color: on ? "var(--c-live)" : "var(--c-ink-faint)",
        background: on ? "var(--c-live-wash)" : undefined,
      }}
    >
      {children}
    </button>
  );
}
