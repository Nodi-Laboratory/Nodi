"use client";

/**
 * 개념 지도 — **어떤 개념 뭉치가 어디 있는지**를 이름으로 보여 준다 (D136).
 *
 * ## 축소 사진은 이 배치에 맞지 않았다
 *
 * 한동안 world 기하를 196×124px로 축소해 그렸다. 그런데 배치가 **태그 열**이라
 * 열이 늘수록 가로로 벌어진다 — 열 8개면 world 폭이 4천 px을 넘고, 축척이
 * 0.04까지 떨어져 열 하나가 18px짜리 얼룩이 된다. 라벨을 그릴 자리가 없어
 * 실측 결과 **사각형 9개에 이름은 1개만** 보였다. 사용자 지적 그대로다:
 * "지도에 개념들이 잘 보이지도 않아."
 *
 * ## 이름이 먼저다
 *
 * 이 배치에서 위치 정보는 사실상 1차원이다 — **몇 번째 열인가**. 그래서 2차원
 * 축소도를 버리고 열 순서를 그대로 세로 목록으로 편다:
 *
 *     ▊ 지구과학    6      ← 색 막대 = 그 열이 차지한 세로 분량
 *     ▊ 생명과학    2
 *     ▊ 화학        1
 *
 * 위의 가는 띠가 열들의 가로 배열과 **지금 보고 있는 구간**을 나타낸다. 목록을
 * 누르면 그 열로 날아간다. 이름·개수·위치가 전부 읽히고, 무엇보다 축척에
 * 상관없이 항상 읽힌다.
 */

import { useMemo, useState } from "react";
import { Map as MapIcon, X } from "lucide-react";
import { ITEM_W, UNTAGGED, type Placed } from "@/lib/canvas2/layout";
import type { Rect } from "@/lib/canvas2/rect";
import { union } from "@/lib/canvas2/rect";
import type { Size } from "@/lib/canvas2/useItemLayout";
import type { Camera, CanvasItem } from "@/lib/canvas2/types";

/** 패널 폭. 태그 이름이 잘리지 않을 만큼은 필요하다. */
const W = 216;
/**
 * 오른쪽 여백 — **도구 레일을 피한다.**
 *
 * 레일은 `right-4`에 폭 36 + 패딩 12로 서 있고 세로 중앙 정렬이라, 지도를
 * 그냥 `right-4`에 두면 목록이 길어질 때 레일 아래로 파고든다(실측: "화학"
 * 행이 레일에 가렸다). 높이를 줄여 피하는 방법도 있지만 화면이 낮아지면
 * 다시 겹친다 — 아예 옆으로 비킨다.
 *
 * 레일이 오른쪽에서 차지하는 폭은 실측 66px(테두리 포함)이고 여기에 여유
 * 10px을 더했다. 레일 크기를 바꾸면 이 값도 같이 봐야 한다.
 */
const RIGHT = 76;
/** 목록 최대 높이 — 넘으면 스크롤한다(휠은 캔버스로 새지 않는다). */
const LIST_MAX_H = 176;
/** 열 배열 띠의 높이. */
const STRIP_H = 20;
/**
 * 이 폭 아래에서는 기본으로 접는다.
 *
 * 교실에서 태블릿을 쓴다. 세로로 세운 아이패드에서는 지도·상단바·도구 레일이
 * 오른쪽 위에서 서로 겹친다.
 */
const COLLAPSE_BELOW = 1024;
const FALLBACK: Size = { w: ITEM_W, h: 180 };

interface Props {
  items: CanvasItem[];
  positions: Map<string, Placed>;
  sizes: Map<string, Size>;
  /** 태그 순서(첫 등장). 목록에 세울 순서다. */
  tagOrder: readonly string[];
  camera: Camera;
  viewport: { w: number; h: number };
  /** world 좌표로 이동. */
  onJump: (world: { x: number; y: number }) => void;
}

interface Group {
  tag: string;
  /** 사용자에게 보일 이름. 분류 없는 열은 따로 부른다. */
  label: string;
  count: number;
  /** 이 열이 차지한 world 영역. */
  box: Rect;
  /** AI가 쓴 글의 비율(0~1). 막대 색을 정한다. */
  aiRatio: number;
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

    // 열 순서대로. tagOrder에 없는 태그(방금 생긴 것)는 뒤에 붙인다.
    const order = [...tagOrder, ...byTag.keys()].filter(
      (t, i, a) => a.indexOf(t) === i && byTag.has(t),
    );

    const groups: Group[] = order.map((tag) => {
      const g = byTag.get(tag)!;
      return {
        tag,
        label: tag === UNTAGGED ? "분류 없음" : tag,
        count: g.rects.length,
        box: union(g.rects)!,
        aiRatio: g.ai / g.rects.length,
      };
    });

    const most = Math.max(...groups.map((g) => g.count));
    const all = union(groups.map((g) => g.box))!;
    // 지금 보고 있는 가로 구간(world). world = screen/zoom - scroll
    const viewX0 = -camera.scrollX;
    const viewX1 = viewX0 + viewport.w / camera.zoom;

    return { groups, most, all, viewX0, viewX1 };
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

  const span = Math.max(1, model.all.w);
  /** world x → 띠 안의 비율(0~1). */
  const at = (x: number) => Math.min(1, Math.max(0, (x - model.all.x) / span));

  return (
    <div
      data-no-pan
      // 오른쪽 위 — 사용자 지시.
      className="ui absolute top-16 z-30 overflow-hidden rounded-lg border"
      style={{
        right: RIGHT,
        width: W,
        background: "var(--c-raised)",
        borderColor: "var(--c-rule)",
        boxShadow: "var(--c-shadow-md)",
      }}
    >
      <div className="flex items-center justify-between px-2.5 pt-2">
        <span className="label" style={{ color: "var(--c-ink-faint)", letterSpacing: 0 }}>
          개념 지도
        </span>
        <button
          type="button"
          onClick={() => setOverride(false)}
          aria-label="개념 지도 닫기"
          className="rounded p-0.5 transition-colors hover:bg-[var(--c-sunk)]"
          style={{ color: "var(--c-ink-faint)" }}
        >
          <X size={12} />
        </button>
      </div>

      {/* 열들의 가로 배열 + 지금 보는 구간. 위치 감각은 여기서 준다. */}
      <div
        aria-hidden
        className="relative mx-2.5 mt-1.5"
        style={{ height: STRIP_H, background: "var(--c-sunk)", borderRadius: 3 }}
      >
        {model.groups.map((g) => (
          <div
            key={g.tag}
            className="absolute"
            style={{
              left: `${at(g.box.x) * 100}%`,
              width: `${Math.max(2, (g.box.w / span) * 100)}%`,
              top: 3,
              bottom: 3,
              borderRadius: 2,
              background: "var(--c-live)",
              opacity: 0.18 + (g.count / model.most) * 0.34,
            }}
          />
        ))}
        {/* 지금 보고 있는 가로 구간 */}
        <div
          className="absolute"
          style={{
            left: `${at(model.viewX0) * 100}%`,
            width: `${Math.max(3, (at(model.viewX1) - at(model.viewX0)) * 100)}%`,
            top: 0,
            bottom: 0,
            border: "1.5px solid var(--c-ink)",
            borderRadius: 3,
            opacity: 0.5,
          }}
        />
      </div>

      {/* 이름 목록 — 이 화면의 요지. 축척과 무관하게 항상 읽힌다. */}
      <ul
        className="mt-1.5 overflow-auto pb-1.5"
        style={{ maxHeight: LIST_MAX_H }}
        aria-label="개념 분류 목록"
      >
        {model.groups.map((g) => (
          <li key={g.tag}>
            <button
              type="button"
              onClick={() =>
                onJump({ x: g.box.x + g.box.w / 2, y: g.box.y + Math.min(g.box.h / 2, 260) })
              }
              title={`${g.label} — 글 ${g.count}개. 눌러서 이동`}
              className="flex w-full items-center gap-2 px-2.5 py-1 text-left transition-colors hover:bg-[var(--c-sunk)]"
            >
              {/* 막대 길이 = 그 열의 분량, 색 = 누가 썼나(오커 AI · 틸 학생) */}
              <span
                aria-hidden
                className="shrink-0 rounded-full"
                style={{
                  width: 3,
                  height: 12 + (g.count / model.most) * 8,
                  background: g.aiRatio >= 0.5 ? "var(--c-live)" : "var(--c-hand)",
                }}
              />
              <span
                className="min-w-0 flex-1 truncate text-[12px]"
                style={{
                  color: g.tag === UNTAGGED ? "var(--c-ink-faint)" : "var(--c-ink)",
                }}
              >
                {g.label}
              </span>
              <span className="label shrink-0" style={{ color: "var(--c-ink-faint)" }}>
                {g.count}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
