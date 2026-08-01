"use client";

/**
 * 개념 지도 — **태그 하나 = 점 하나** (D139).
 *
 * ## 두 번 헤맨 끝에 옛 방식으로 돌아왔다
 *
 * v1이 쓰던 방식이 이것이다: 태그를 실제 위치의 축소 점으로 찍고, 점 크기로
 * 개수를, 라벨로 이름을 보여 준다. 그 사이 두 가지를 시도했다가 둘 다 사용자
 * 지적을 받았다.
 *
 *   아이템마다 사각형   글이 20개면 사각형이 20개다. 같은 열 안에서 세로로
 *                       포개져 **겹쳐 보였다** — "겹치는 부분이 많아서 오히려
 *                       보기 힘들다."
 *   이름 목록           겹침은 없앴지만 **공간 정보가 사라졌다**. 어디에 있는지가
 *                       아니라 무엇이 있는지만 남았다.
 *
 * 점 방식은 둘을 동시에 만족한다. 태그당 하나라 **원리적으로 태그 수만큼만**
 * 그려지고(열이 8개면 점도 8개), 자리는 실제 열 좌표를 축소한 것이라 공간
 * 정보가 살아 있다. 라벨은 점에 붙어 다니므로 축척과 무관하게 읽힌다.
 *
 * 열 간격(`COL_GAP` 240)을 넓힌 것과 한 쌍이다 — 열이 붙어 있으면 점도 붙어
 * 찍힌다.
 */

import { useMemo, useState } from "react";
import { Map as MapIcon, X } from "lucide-react";
import { ITEM_W, UNTAGGED, type Placed } from "@/lib/canvas2/layout";
import type { Rect } from "@/lib/canvas2/rect";
import { union } from "@/lib/canvas2/rect";
import type { Size } from "@/lib/canvas2/useItemLayout";
import type { Camera, CanvasItem } from "@/lib/canvas2/types";

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
 * 이 폭 아래에서는 기본으로 접는다.
 *
 * 교실에서 태블릿을 쓴다. 세로로 세운 아이패드에서는 지도·상단바·도구 레일이
 * 오른쪽 위에서 서로 겹친다.
 */
const COLLAPSE_BELOW = 1024;
/** 도구 레일이 오른쪽에서 차지하는 폭(실측 66) + 여유. */
const RIGHT = 76;
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
  /** world 좌표로 이동. */
  onJump: (world: { x: number; y: number }) => void;
}

export function Minimap({
  items,
  positions,
  sizes,
  tagOrder,
  camera,
  viewport,
  onJump,
}: Props) {
  // 학생이 직접 열고 닫은 적이 있으면 그 선택을 따르고, 아니면 폭으로 정한다.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? viewport.w >= COLLAPSE_BELOW;

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
      };
    });

    // 지금 보고 있는 영역(world). world = screen/zoom - scroll
    const view: Rect = {
      x: -camera.scrollX,
      y: -camera.scrollY,
      w: viewport.w / camera.zoom,
      h: viewport.h / camera.zoom,
    };

    // 점과 뷰포트를 모두 담는 범위. 점은 크기가 없으므로 1px 사각형으로 친다.
    const box = union([...dots.map((d) => ({ x: d.wx, y: d.wy, w: 1, h: 1 })), view])!;

    // **양축에 같은 배율**을 쓴다 — 다르게 주면 실제로 나란한 열이 지도에서
    // 비스듬해 보여 공간 정보가 거짓이 된다.
    const s = Math.min(
      (W - PAD * 2) / Math.max(1, box.w),
      (H - PAD * 2) / Math.max(1, box.h),
    );
    const ox = PAD + (W - PAD * 2 - box.w * s) / 2;
    const oy = PAD + (H - PAD * 2 - box.h * s) / 2;
    const px = (x: number) => ox + (x - box.x) * s;
    const py = (y: number) => oy + (y - box.y) * s;

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
    // 민 뒤에 화폭을 벗어날 수 있다 — 라벨까지 들어오게 가둔다.
    for (const d of placed) {
      d.cx = Math.min(W - d.hw - 2, Math.max(d.hw + 2, d.cx));
      d.cy = Math.min(H - d.hh - 2, Math.max(d.r + 6, d.cy));
    }

    return {
      dots: placed,
      view: { x: px(view.x), y: py(view.y), w: view.w * s, h: view.h * s },
    };
  }, [items, positions, sizes, tagOrder, camera, viewport]);

  if (!model) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-no-pan
        onClick={() => setOverride(true)}
        aria-label="개념 지도 열기"
        title="개념 지도"
        className="ui absolute top-16 z-30 flex h-9 w-9 items-center justify-center rounded-lg border transition-colors"
        style={{
          right: RIGHT,
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

  return (
    <div
      data-no-pan
      // 오른쪽 위 — 사용자 지시. 도구 레일은 피한다.
      className="ui absolute top-16 z-30 overflow-hidden rounded-lg border"
      style={{
        right: RIGHT,
        background: "var(--c-raised)",
        borderColor: "var(--c-rule)",
        boxShadow: "var(--c-shadow-md)",
      }}
    >
      <button
        type="button"
        onClick={() => setOverride(false)}
        aria-label="개념 지도 닫기"
        className="absolute right-1 top-1 z-10 rounded p-1 transition-colors hover:bg-[var(--c-sunk)]"
        style={{ color: "var(--c-ink-faint)" }}
      >
        <X size={12} />
      </button>

      <svg width={W} height={H} className="block" aria-label="개념 지도">
        {/* 지금 보고 있는 영역. 점보다 뒤에 옅게 — 정보는 점이 준다. */}
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

        {model.dots.map((d) => (
          <g
            key={d.tag}
            transform={`translate(${d.cx},${d.cy})`}
            style={{ cursor: "pointer" }}
            onClick={() => onJump({ x: d.wx, y: d.wy })}
          >
            <title>{`${d.label} — 글 ${d.count}개. 눌러서 이동`}</title>
            {/* **보이지 않는 클릭 영역.**
                SVG는 그려진 부분만 히트 테스트한다. 점과 아래 라벨 사이의 빈
                틈을 누르면 아무것도 안 잡혀 이동이 안 됐다(실측: 카메라가
                15px만 움직임). 점+라벨을 함께 덮는 원을 깔아 둔다 —
                `fill="none"`은 안 잡히므로 투명 채움 + pointerEvents가 필요하다. */}
            <circle
              r={d.r + 16}
              fill="transparent"
              style={{ pointerEvents: "all" }}
            />
            {/* 색은 누가 채웠나(오커 AI · 틸 학생), 크기는 글 수 */}
            <circle
              r={d.r}
              fill={d.aiRatio >= 0.5 ? "var(--c-live)" : "var(--c-hand)"}
              fillOpacity={0.3}
              stroke={d.aiRatio >= 0.5 ? "var(--c-live)" : "var(--c-hand)"}
              strokeOpacity={0.75}
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
        ))}
      </svg>
    </div>
  );
}
