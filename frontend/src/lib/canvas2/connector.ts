/**
 * 연결선 기하 (D126) — 어느 변에서 나가고 어디로 들어갈지.
 *
 * 컴포넌트에서 떼어 낸 이유는 하나다: **검증할 수 있어야 한다.** 사용자가
 * 보낸 화면에서 두 연결선이 겹쳐 지나갔는데, 그건 시작점이 언제나 같은 한 점
 * (부모 오른쪽 변 중앙)이었기 때문이다. 그런 종류의 결함은 눈으로 보기 전에
 * 테스트로 잡혀야 한다.
 *
 * ## 규칙
 *
 * 1. **변은 상대 위치가 정한다.** 답이 오른쪽이면 오른쪽 변, 아래면 아래 변.
 * 2. **변 위 지점도 상대가 정한다.** 상대 중심을 그 변에 투영한다 — 답이 둘
 *    이면 하나는 위쪽에서, 하나는 아래쪽에서 나가므로 겹치지 않는다.
 * 3. **끝점은 박스 밖에 선다.** 도트가 테두리에 걸치거나 안쪽에 박히지 않게
 *    `END_GAP`만큼 물린다.
 */

import type { Rect } from "./rect";

/** 끝점을 박스 밖으로 물리는 거리. */
export const END_GAP = 7;
/** 변 위에서 앵커가 모서리에 붙지 않도록 남기는 여백. */
export const EDGE_INSET = 18;

export type Side = "right" | "left" | "top" | "bottom";

export interface Point {
  x: number;
  y: number;
}

export interface LinkGeometry {
  /** 시작점(부모 쪽, 박스 밖). */
  a: Point;
  /** 끝점(자식 쪽, 박스 밖). */
  b: Point;
  /** 3차 베지어 제어점. */
  c1: Point;
  c2: Point;
  sideA: Side;
  sideB: Side;
}

function clamp(v: number, lo: number, hi: number): number {
  // 박스가 여백 두 배보다 좁으면 lo > hi가 된다 — 그때는 변의 중앙을 쓴다.
  return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
}

export function center(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** `rect`에서 `toward`를 향해 나가는 변과 그 변 위의 지점. */
export function anchor(rect: Rect, toward: Point): Point & { side: Side } {
  const c = center(rect);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;

  // 축을 그냥 비교하면 넓적한 박스에서 위아래로 나가 선이 박스를 가로지른다.
  // 박스의 종횡비로 가중해 "이 박스에서 어느 쪽이 자연스러운가"를 반영한다.
  const horizontal = Math.abs(dx) * rect.h >= Math.abs(dy) * rect.w;

  if (horizontal) {
    const side: Side = dx >= 0 ? "right" : "left";
    return {
      x: side === "right" ? rect.x + rect.w : rect.x,
      y: clamp(toward.y, rect.y + EDGE_INSET, rect.y + rect.h - EDGE_INSET),
      side,
    };
  }
  const side: Side = dy >= 0 ? "bottom" : "top";
  return {
    x: clamp(toward.x, rect.x + EDGE_INSET, rect.x + rect.w - EDGE_INSET),
    y: side === "bottom" ? rect.y + rect.h : rect.y,
    side,
  };
}

/** 변의 바깥 방향 단위 벡터. */
export function normal(side: Side): Point {
  switch (side) {
    case "right":
      return { x: 1, y: 0 };
    case "left":
      return { x: -1, y: 0 };
    case "bottom":
      return { x: 0, y: 1 };
    default:
      return { x: 0, y: -1 };
  }
}

/** 부모 → 자식 연결선의 전체 기하. */
export function linkGeometry(parent: Rect, child: Rect): LinkGeometry {
  const a0 = anchor(parent, center(child));
  const b0 = anchor(child, center(parent));
  const na = normal(a0.side);
  const nb = normal(b0.side);

  const a = { x: a0.x + na.x * END_GAP, y: a0.y + na.y * END_GAP };
  const b = { x: b0.x + nb.x * END_GAP, y: b0.y + nb.y * END_GAP };

  // 제어점 거리 — 멀수록 완만하게. 상한이 없으면 멀리 떨어진 답으로 가는
  // 곡선이 화면 밖으로 크게 부푼다.
  const bow = clamp(Math.hypot(b.x - a.x, b.y - a.y) * 0.42, 36, 190);

  return {
    a,
    b,
    c1: { x: a.x + na.x * bow, y: a.y + na.y * bow },
    c2: { x: b.x + nb.x * bow, y: b.y + nb.y * bow },
    sideA: a0.side,
    sideB: b0.side,
  };
}

/** 3차 베지어의 t=0.5 지점. 라벨을 선 **위에** 얹으려면 이 값이 필요하다. */
export function midpoint(g: LinkGeometry): Point {
  return {
    x: (g.a.x + 3 * g.c1.x + 3 * g.c2.x + g.b.x) / 8,
    y: (g.a.y + 3 * g.c1.y + 3 * g.c2.y + g.b.y) / 8,
  };
}
