"use client";

/**
 * 개념 지도 — **덩어리가 어디에 있는지**만 보여 준다.
 *
 * 한동안 아이템 하나하나를 점으로 찍었는데, 사용자가 되돌리라고 했다:
 * "지도의 목적은 개념들의 덩어리가 어디에 위치하는지 보여주기 위함이지
 * 여러 요소들의 위치를 세세하게 보여줄 목적은 아니었다."
 *
 * 맞는 지적이다. 200×132px 안에 스무 개짜리 사각형을 늘어놓으면 어느 것이
 * 무엇인지 알 수 없는 얼룩이 된다. 지도가 답해야 하는 질문은 "저 개념 뭉치가
 * 어느 쪽에 있나" 하나다. 그래서 **태그 덩어리 + 지금 보는 영역** 둘만 그린다.
 * 그림 요소도, 아이템 개별 사각형도 그리지 않는다.
 *
 * 덩어리의 진하기는 그 안에 든 글 수를 나타낸다 — 어디가 두꺼운 뭉치인지가
 * 크기만이 아니라 색으로도 읽힌다.
 */

import { useMemo, useState } from "react";
import { Map as MapIcon, X } from "lucide-react";
import { ITEM_W, UNTAGGED, type Placed } from "@/lib/canvas2/layout";
import type { Rect } from "@/lib/canvas2/rect";
import { union } from "@/lib/canvas2/rect";
import type { Size } from "@/lib/canvas2/useItemLayout";
import type { Camera, CanvasItem } from "@/lib/canvas2/types";

const W = 196;
const H = 124;
/**
 * 이 폭 아래에서는 기본으로 접는다.
 *
 * 교실에서 태블릿을 쓴다. 세로로 세운 아이패드(캔버스 폭 ~756px)에서는
 * 지도·상단바·도구 레일이 오른쪽 위에서 서로 겹친다.
 */
const COLLAPSE_BELOW = 1024;
const PAD = 12;
const FALLBACK: Size = { w: ITEM_W, h: 180 };
/** 덩어리 사각형에 두르는 여유(world px). 글자에 딱 붙으면 답답하다. */
const GROUP_PAD = 26;

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  sizes: Map<string, Size>;
  /** 태그 → 열 x. 덩어리를 태그별로 가르는 기준. */
  columnX: Map<string, number>;
  /** 태그 순서(첫 등장). 라벨을 그릴 순서다. */
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
  columnX,
  tagOrder,
  camera,
  viewport,
  onJump,
}: Props) {
  // 학생이 직접 열고 닫은 적이 있으면 그 선택을 따르고, 아니면 폭으로 정한다.
  // 이펙트로 state를 동기화하지 않는다 — 파생값이라 렌더 중에 계산하면 된다.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? viewport.w >= COLLAPSE_BELOW;

  const model = useMemo(() => {
    /** 태그 → 그 태그 글들의 사각형. */
    const byTag = new Map<string, Rect[]>();
    for (const it of items) {
      const p = positions.get(it.id);
      if (!p) continue;
      const s = sizes.get(it.id) ?? FALLBACK;
      const tag = it.tag || UNTAGGED;
      const list = byTag.get(tag);
      const r: Rect = { x: p.x, y: p.y, w: s.w, h: s.h };
      if (list) list.push(r);
      else byTag.set(tag, [r]);
    }

    // 덩어리 — 태그 하나가 덩어리 하나다. 분류 없는 글도 하나로 묶어 보여 준다
    // (안 보여 주면 "글이 있는데 지도에 없다"가 된다).
    const groups = [...tagOrder, ...byTag.keys()]
      .filter((t, i, a) => a.indexOf(t) === i)
      .map((tag) => {
        const rects = byTag.get(tag);
        if (!rects?.length) return null;
        const b = union(rects)!;
        return {
          tag,
          count: rects.length,
          // 열 x가 있으면 그쪽으로 정렬을 맞춘다 — 덩어리 왼쪽 변이 들쭉날쭉하면
          // 열 구조가 안 읽힌다.
          r: {
            x: (columnX.get(tag) ?? b.x) - GROUP_PAD,
            y: b.y - GROUP_PAD,
            w: b.w + GROUP_PAD * 2,
            h: b.h + GROUP_PAD * 2,
          } as Rect,
        };
      })
      .filter((g): g is NonNullable<typeof g> => !!g);

    // 지금 보고 있는 영역(world). world = screen/zoom - scroll
    const view: Rect = {
      x: -camera.scrollX,
      y: -camera.scrollY,
      w: viewport.w / camera.zoom,
      h: viewport.h / camera.zoom,
    };

    // 내용이 없어도 뷰포트는 보여야 한다 — 빈 캔버스에서 지도만 사라지면
    // 학생은 어디로 움직였는지 알 수 없다.
    const box = union([...groups.map((g) => g.r), view]);
    if (!box) return null;

    const scale = Math.min((W - PAD * 2) / box.w, (H - PAD * 2) / box.h);
    const ox = PAD + (W - PAD * 2 - box.w * scale) / 2;
    const oy = PAD + (H - PAD * 2 - box.h * scale) / 2;
    // **SVG 속성 이름으로 낸다.** 우리 Rect는 w/h를 쓰는데 <rect>는
    // width/height다. w/h로 스프레드하면 React가 무시하고 크기가 0이 된다
    // (실측: 점이 전부 안 보이는데 좌표는 맞아서 원인이 안 드러났다).
    const project = (r: Rect) => ({
      x: ox + (r.x - box.x) * scale,
      y: oy + (r.y - box.y) * scale,
      width: Math.max(3, r.w * scale),
      height: Math.max(3, r.h * scale),
    });

    const most = Math.max(1, ...groups.map((g) => g.count));
    return {
      groups: groups.map((g) => ({
        ...g,
        p: project(g.r),
        // 글이 많은 덩어리일수록 진하게. 0.10~0.30 사이면 지도가 시끄럽지 않다.
        weight: 0.1 + (g.count / most) * 0.2,
      })),
      view: project(view),
      box,
      scale,
      ox,
      oy,
    };
  }, [items, positions, sizes, columnX, tagOrder, camera, viewport]);

  if (!model) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-no-pan
        onClick={() => setOverride(true)}
        aria-label="개념 지도 열기"
        title="개념 지도"
        className="ui absolute right-4 top-16 z-30 flex h-9 w-9 items-center justify-center rounded-lg border transition-colors"
        style={{
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

  const toWorld = (e: React.MouseEvent<HTMLButtonElement>) => {
    // button이 svg를 감싸므로 svg 자체의 사각형을 쓴다 — button에 패딩이
    // 생기면 좌표가 어긋난다.
    const svg = e.currentTarget.querySelector("svg");
    const r = (svg ?? e.currentTarget).getBoundingClientRect();
    return {
      x: model.box.x + (e.clientX - r.left - model.ox) / model.scale,
      y: model.box.y + (e.clientY - r.top - model.oy) / model.scale,
    };
  };

  return (
    <div
      data-no-pan
      // 오른쪽 위 — 사용자 지시. top-16은 상단바 아래다.
      className="ui absolute right-4 top-16 z-30 overflow-hidden rounded-lg border"
      style={{
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
      {/* 클릭 가능한 role="img"였다 — 키보드로는 접근조차 못 했다.
          button으로 감싸 포커스·Enter/Space를 브라우저에 맡긴다. */}
      <button
        type="button"
        aria-label="개념 지도 — 클릭한 자리로 이동합니다"
        className="block cursor-pointer"
        onClick={(e) => onJump(toWorld(e))}
      >
        <svg width={W} height={H} aria-hidden className="block">
          {model.groups.map((g) => (
            <g key={g.tag}>
              <rect
                {...g.p}
                rx={4}
                fill="var(--c-live)"
                fillOpacity={g.weight}
                stroke="var(--c-live)"
                strokeOpacity={0.34}
                strokeWidth={1}
              />
              {/* 라벨은 덩어리가 충분히 넓을 때만 — 좁으면 글자가 겹쳐 읽을 수 없다 */}
              {g.tag !== UNTAGGED && g.p.width >= 30 && (
                <text
                  x={g.p.x + 4}
                  y={Math.max(9, g.p.y + 11)}
                  fill="var(--c-ink-soft)"
                  style={{ fontFamily: "var(--font-label), monospace", fontSize: 7.5 }}
                >
                  {g.tag.length > 7 ? `${g.tag.slice(0, 7)}…` : g.tag}
                </text>
              )}
            </g>
          ))}
          {/* 지금 보고 있는 영역 */}
          <rect
            {...model.view}
            rx={2}
            fill="var(--c-ink)"
            fillOpacity={0.05}
            stroke="var(--c-ink)"
            strokeOpacity={0.5}
            strokeWidth={1}
          />
        </svg>
      </button>
    </div>
  );
}
