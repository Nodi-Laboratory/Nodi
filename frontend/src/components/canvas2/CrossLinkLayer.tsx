"use client";

/**
 * 교차 세션 개념 연결 배지 (D171).
 *
 * 학생이 어제 다른 과목에서 한 이야기와 지금 보는 카드가 이어져 있으면, 카드
 * 오른쪽 가장자리에 알림이 뜬다. 누르면 설명이 펼쳐지고, 거기서 그때 그
 * 대화로 갈 수 있다.
 *
 * ## 배지는 아이템이 아니다
 *
 * 카드 오른쪽은 이미 도판·클립이 열로 쌓이는 자리고(D163), 배치 엔진의
 * 무겹침은 **알고리즘의 성질**이라(D123) 거기에 새 아이템을 끼우면 그 성질이
 * 깨진다. 그래서 배지는 `ConnectorLayer`처럼 **별도 레이어**로 그린다 —
 * 레이아웃에 참여하지 않고, `TextItem`의 props도 건드리지 않는다
 * (props를 늘리면 `memo(TextItem)`이 매 렌더 깨진다).
 *
 * 펼친 설명도 같은 이유로 오버레이다. 아이템이면 펼칠 때마다 주변 카드를
 * 밀어내야 한다.
 *
 * ## 드래그를 따라간다
 *
 * 아이템은 드래그 중 React를 거치지 않고 DOM transform으로 움직인다(D124).
 * 배지도 React 밖에서 따라가야 한다 — 안 그러면 카드만 가고 배지는 제자리에
 * 남는다(연결선이 겪었던 것과 같은 문제).
 *
 * 오버레이 안이므로 좌표는 그대로 world다.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, ChevronDown, CornerUpLeft, X } from "lucide-react";
import type { CrossLink } from "@/lib/api/crosslink";
import type { Placed } from "@/lib/canvas2/layout";
import type { Size } from "@/lib/canvas2/useItemLayout";
import {
  getDragOffsets,
  subscribeDrag,
  type DragOffset,
} from "@/lib/canvas2/dragBus";

/** 크기를 아직 못 잰 카드의 대체값 — ConnectorLayer와 같은 값을 쓴다. */
const FALLBACK: Size = { w: 460, h: 180 };
/** 카드 오른쪽 변에서 배지까지. 도판·클립 열(COL_GAP 760)보다 훨씬 안쪽이다. */
const GAP = 14;

interface Props {
  links: readonly CrossLink[];
  positions: Map<string, Placed>;
  sizes: Map<string, Size>;
  /** 열어 봤다고 표시 — 깜빡임을 멈춘다. */
  onOpen: (link: CrossLink) => void;
  /** 그때 그 대화로 이동. 공간·세션·카드를 한 번에 옮긴다(D148). */
  onNavigate: (link: CrossLink) => void;
}

/**
 * 말풍선이 배지를 피해 올라갈 높이(px, world) (사용자 지시 2026-08-12).
 *
 * 배지와 질문 방향 말풍선(D194)은 **같은 자리**에 놓인다 — 둘 다 카드
 * 오른쪽 위(`x = 카드 오른쪽 + 간격`, `y = 카드 위`)다. 하나만 뜰 때는
 * 문제가 없지만 함께 뜨면 정확히 포개진다.
 *
 * 비키는 쪽은 **말풍선**이다: 배지는 카드에 딸린 표식이라 그 카드의 윗변에
 * 붙어 있어야 "이 카드의 것"으로 읽히고, 말풍선은 읽고 닫는 것이라 조금 위에
 * 있어도 뜻이 안 바뀐다.
 *
 * 값은 배지 높이(약 30) + 숨 쉴 틈이다. 배지 모양을 바꾸면 여기도 함께 옮긴다 —
 * 그래서 배지를 그리는 이 파일에 둔다.
 */
export const BADGE_LIFT = 42;

export function CrossLinkLayer({
  links,
  positions,
  sizes,
  onOpen,
  onNavigate,
}: Props) {
  return (
    <>
      {links.map((link) => {
        const p = positions.get(link.fromItemId);
        if (!p) return null;
        const s = sizes.get(link.fromItemId) ?? FALLBACK;
        return (
          <CrossLinkBadge
            key={link.id}
            link={link}
            x={p.x + s.w + GAP}
            y={p.y}
            onOpen={onOpen}
            onNavigate={onNavigate}
          />
        );
      })}
    </>
  );
}

function CrossLinkBadge({
  link,
  x,
  y,
  onOpen,
  onNavigate,
}: {
  link: CrossLink;
  x: number;
  y: number;
  onOpen: (link: CrossLink) => void;
  onNavigate: (link: CrossLink) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  /**
   * 아직 안 열어 본 알림만 깜빡인다. 한 번 본 알림이 계속 깜빡이면 그냥
   * 소음이고, 학생은 곧 캔버스 전체를 무시하게 된다.
   *
   * 서버 값(openedAt)과 로컬 상태를 함께 본다 — 열자마자 멈춰야 하는데
   * 서버 응답을 기다리면 몇백 ms 더 깜빡인다.
   */
  const [seen, setSeen] = useState(link.openedAt !== null);

  /** 드래그를 따라간다 — 카드가 React 밖에서 움직이므로 여기도 밖에서 따른다. */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const apply = (offsets: ReadonlyMap<string, DragOffset>) => {
      const d = offsets.get(link.fromItemId);
      el.style.transform = d ? `translate(${d.dx}px, ${d.dy}px)` : "";
    };
    apply(getDragOffsets());
    return subscribeDrag(apply);
  }, [link.fromItemId]);

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !seen) {
      setSeen(true);
      onOpen(link);
    }
  };

  const subject = link.to.tag?.trim() || link.to.sessionTitle?.trim() || "예전 대화";

  return (
    <div
      ref={boxRef}
      className="pointer-events-none absolute"
      style={{ left: x, top: y }}
    >
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-label={`다른 대화와 연결됨: ${subject}`}
        title={`${subject}에서 한 이야기와 이어져 있어요`}
        className={[
          "pointer-events-auto flex items-center gap-1 rounded-full border px-2.5 py-1",
          "border-accent-border/60 bg-bg-elevated text-[11px] font-medium",
          "text-accent-deep shadow-sm transition-colors hover:bg-accent/10",
          // 안 본 알림만 깜빡인다. reduced-motion이면 애니메이션 없이 강조만.
          seen ? "" : "motion-safe:animate-pulse ring-2 ring-accent/50",
        ].join(" ")}
      >
        <ArrowLeftRight size={12} />
        <span className="max-w-[10rem] truncate">{subject}</span>
        <ChevronDown
          size={12}
          className={open ? "rotate-180 transition-transform" : "transition-transform"}
        />
      </button>

      {open ? (
        <div
          className={[
            "pointer-events-auto mt-1.5 w-72 rounded-2xl border p-3",
            "border-accent-border/50 bg-bg-elevated shadow-xl",
          ].join(" ")}
        >
          <div className="mb-1.5 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-accent-deep">
                예전에 공부한 것과 이어져요
              </p>
              <p className="mt-0.5 truncate text-xs text-fg-muted">
                {link.to.title?.trim() || subject}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="shrink-0 text-fg-muted hover:text-fg"
              aria-label="접기"
            >
              <X size={14} />
            </button>
          </div>

          <p className="whitespace-pre-wrap text-xs leading-relaxed text-fg">
            {link.explanation}
          </p>

          <button
            type="button"
            onClick={() => onNavigate(link)}
            className={[
              "mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg",
              "bg-accent px-3 py-2 text-xs font-medium text-accent-fg",
              "transition-opacity hover:opacity-90",
            ].join(" ")}
          >
            <CornerUpLeft size={13} />
            과거 대화로 돌아가기
          </button>
        </div>
      ) : null}
    </div>
  );
}
