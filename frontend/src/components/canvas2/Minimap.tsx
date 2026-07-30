"use client";

/**
 * 미니맵 — v1의 `ConceptMinimap`을 대체한다.
 *
 * v1에서는 개념 카드를 점으로 찍는 정도였고 **뷰포트 사각형을 그리지 않았다**
 * (`minimapLayout.viewportRectPx`가 구현돼 있었는데 아무도 호출하지 않았다).
 * v2는 학생이 캔버스를 자유롭게 끌고 다니므로 "지금 어디를 보고 있나"가 훨씬
 * 중요해졌다 — 그래서 사각형을 그리고, 클릭하면 그 자리로 날아간다.
 *
 * 색으로 출처를 그대로 보여 준다(파랑=AI, 주황=학생). 축소해 놓고 봐도 학생이
 * 스스로 채운 분량이 보이는 것이 이 화면의 요지다.
 */

import { useMemo, useState } from "react";
import { Map as MapIcon, X } from "lucide-react";
import { ITEM_W, UNTAGGED, type Placed } from "@/lib/canvas2/layout";
import type { Rect } from "@/lib/canvas2/rect";
import { union } from "@/lib/canvas2/rect";
import type { Camera, CanvasItem } from "@/lib/canvas2/types";

const W = 200;
const H = 132;
/**
 * 이 폭 아래에서는 기본으로 접는다.
 *
 * 교실에서 태블릿을 쓴다. 세로로 세운 아이패드(캔버스 폭 ~756px)에서는
 * 미니맵·입력창·도구 레일이 하단에서 서로 겹친다. 셋 다 접근 가능하게 두는
 * 것보다 **입력창을 방해하지 않는 것**이 우선이다 — 질문을 못 쓰면 이 화면은
 * 쓸모가 없다.
 */
const COLLAPSE_BELOW = 1024;
const PAD = 10;
const FALLBACK_H = 180;

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  heights: Map<string, number>;
  /** 태그 → 열 x. 태그 그룹 경계를 그리는 데 쓴다. */
  columnX: Map<string, number>;
  /** 태그 순서(첫 등장). 라벨을 그릴 순서다. */
  tagOrder: readonly string[];
  /**
   * 그림 요소를 그때그때 읽는다. 배열을 prop으로 받으면 매 렌더 새 아이덴티티가
   * 되어 아래 useMemo가 무력화된다 — 이 함수는 api에만 의존해 안정적이다.
   */
  getObstacles: () => Rect[];
  camera: Camera;
  viewport: { w: number; h: number };
  /** world 좌표로 이동. */
  onJump: (world: { x: number; y: number }) => void;
}

export function Minimap({
  items,
  positions,
  heights,
  columnX,
  tagOrder,
  getObstacles,
  camera,
  viewport,
  onJump,
}: Props) {
  // 학생이 직접 열고 닫은 적이 있으면 그 선택을 따르고, 아니면 폭으로 정한다.
  // 이펙트로 state를 동기화하지 않는다 — 파생값이라 렌더 중에 계산하면 된다
  // (이펙트 안 setState는 연쇄 렌더를 만든다).
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? viewport.w >= COLLAPSE_BELOW;

  const model = useMemo(() => {
    const rects = items
      .map((i) => {
        const p = positions.get(i.id);
        if (!p) return null;
        return {
          id: i.id,
          source: i.source,
          r: { x: p.x, y: p.y, w: ITEM_W, h: heights.get(i.id) ?? FALLBACK_H },
        };
      })
      .filter((v): v is NonNullable<typeof v> => !!v);

    // 지금 보고 있는 영역(world). world = screen/zoom - scroll
    const view: Rect = {
      x: -camera.scrollX,
      y: -camera.scrollY,
      w: viewport.w / camera.zoom,
      h: viewport.h / camera.zoom,
    };

    // 내용이 없어도 뷰포트는 보여야 한다 — 빈 캔버스에서 미니맵만 사라지면
    // 학생은 어디로 움직였는지 알 수 없다.
    const draws = getObstacles();
    const box = union([...rects.map((v) => v.r), ...draws, view]);
    if (!box) return null;

    const scale = Math.min((W - PAD * 2) / box.w, (H - PAD * 2) / box.h);
    const ox = PAD + ((W - PAD * 2) - box.w * scale) / 2;
    const oy = PAD + ((H - PAD * 2) - box.h * scale) / 2;
    // **SVG 속성 이름으로 낸다.** 우리 Rect는 w/h를 쓰는데 <rect>는
    // width/height다. w/h로 스프레드하면 React가 무시하고 크기가 0이 된다
    // (실측: 점이 전부 안 보이는데 좌표는 맞아서 원인이 안 드러났다).
    const project = (r: Rect) => ({
      x: ox + (r.x - box.x) * scale,
      y: oy + (r.y - box.y) * scale,
      width: Math.max(2, r.w * scale),
      height: Math.max(2, r.h * scale),
    });

    /**
     * 태그 그룹 — 사용자가 지적한 "태그별로 묶인 위치를 지도로 보여주는 기능".
     *
     * 각 태그가 차지한 영역을 감싸는 사각형과 이름을 낸다. 열 x가 정해져
     * 있으므로 그 열에 놓인 아이템들만 묶는다 — pinned로 딴 데 옮긴 아이템은
     * 그 태그 그룹의 경계를 왜곡하지 않는다(학생이 일부러 뺀 것이다).
     */
    const groups = tagOrder
      .filter((t) => t !== UNTAGGED)
      .map((tag) => {
        const cx = columnX.get(tag);
        if (cx === undefined) return null;
        const mine = rects.filter((v) => {
          const it = items.find((i) => i.id === v.id);
          return (it?.tag || UNTAGGED) === tag && Math.abs(v.r.x - cx) < 1;
        });
        const b = union(mine.map((v) => v.r));
        if (!b) return null;
        return { tag, p: project({ x: b.x, y: b.y, w: b.w, h: b.h }) };
      })
      .filter((g): g is NonNullable<typeof g> => !!g);

    return {
      rects: rects.map((v) => ({ ...v, p: project(v.r) })),
      groups,
      draws: draws.map(project),
      view: project(view),
      box,
      scale,
      ox,
      oy,
    };
  }, [items, positions, heights, columnX, tagOrder, getObstacles, camera, viewport]);

  if (!model) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-no-pan
        onClick={() => setOverride(true)}
        aria-label="전체 지도 열기"
        title="전체 지도"
        className="ui absolute bottom-6 left-4 z-30 flex h-9 w-9 items-center justify-center rounded-lg border transition-colors"
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
      className="ui absolute bottom-6 left-4 z-30 overflow-hidden rounded-lg border"
      style={{
        background: "var(--c-raised)",
        borderColor: "var(--c-rule)",
        boxShadow: "var(--c-shadow-md)",
      }}
    >
      <button
        type="button"
        onClick={() => setOverride(false)}
        aria-label="전체 지도 닫기"
        className="absolute right-1 top-1 z-10 rounded p-1 transition-colors hover:bg-[var(--c-sunk)]"
        style={{ color: "var(--c-ink-faint)" }}
      >
        <X size={12} />
      </button>
      {/* 클릭 가능한 role="img"였다 — 키보드로는 접근조차 못 했다.
          button으로 감싸 포커스·Enter/Space를 브라우저에 맡긴다. */}
      <button
        type="button"
        aria-label="캔버스 전체 지도 — 클릭한 자리로 이동합니다"
        className="block cursor-pointer"
        onClick={(e) => onJump(toWorld(e))}
      >
      <svg width={W} height={H} aria-hidden className="block">
        {/* 그림은 배경에 옅게 */}
        {model.draws.map((d, i) => (
          <rect
            key={`d${i}`}
            {...d}
            rx={1}
            fill="var(--c-rule)"
            opacity={0.5}
          />
        ))}
        {/* 태그 그룹 — 아이템 뒤, 그림 위 */}
        {model.groups.map((g) => (
          <g key={g.tag}>
            <rect
              x={g.p.x - 3}
              y={g.p.y - 3}
              width={g.p.width + 6}
              height={g.p.height + 6}
              rx={3}
              fill="var(--c-live)"
              fillOpacity={0.06}
              stroke="var(--c-live)"
              strokeOpacity={0.28}
              strokeWidth={1}
            />
            {/* 라벨은 그룹이 충분히 넓을 때만 — 좁으면 글자가 겹쳐 읽을 수 없다 */}
            {g.p.width >= 26 && (
              <text
                x={g.p.x - 2}
                y={Math.max(8, g.p.y - 5)}
                fill="var(--c-ink-soft)"
                style={{ fontFamily: "var(--font-label), monospace", fontSize: 7 }}
              >
                {g.tag.length > 6 ? `${g.tag.slice(0, 6)}…` : g.tag}
              </text>
            )}
          </g>
        ))}
        {model.rects.map((v) => (
          <rect
            key={v.id}
            {...v.p}
            rx={1.5}
            fill={v.source === "ai" ? "var(--c-live)" : "var(--c-hand)"}
            // 0.55에서 올렸다 — 따뜻한 종이 위에서 반투명 오커와 반투명 틸이
            // 둘 다 옅은 갈색으로 뭉개졌다(실측).
            opacity={0.8}
          />
        ))}
        {/* 지금 보고 있는 영역 */}
        <rect
          {...model.view}
          rx={2}
          fill="var(--c-ink)"
          fillOpacity={0.05}
          stroke="var(--c-ink)"
          strokeOpacity={0.45}
          strokeWidth={1}
        />
      </svg>
      </button>
    </div>
  );
}
