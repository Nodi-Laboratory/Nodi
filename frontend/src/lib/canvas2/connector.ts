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

/**
 * 끝점이 앉는 **패딩 상자**의 두께 (사용자 지시 2026-07-31).
 *
 * 글자 사각형이 아니라 그 바깥에 씌운 상자의 변에 끝점을 둔다. 값은 hover 시
 * 깔리는 박스(`TextItem`의 `inset: -12px -16px`)에 맞춘 것이다 — 눈에 보이는
 * 상자와 선이 만나는 자리가 같아야 "저 상자에서 나온 선"으로 읽힌다.
 * 가로가 더 두꺼운 것도 그 상자를 따른 것이다.
 */
export const PAD_X = 16;
export const PAD_Y = 12;
/** 패딩 상자에서 한 번 더 띄우는 거리. 도트가 테두리에 걸치지 않게. */
export const END_GAP = 4;
/** 변 위에서 앵커가 모서리에 붙지 않도록 남기는 여백. */
export const EDGE_INSET = 18;

/** 패딩을 씌운 상자. 연결선이 실제로 붙는 대상이다. */
export function padded(r: Rect): Rect {
  return { x: r.x - PAD_X, y: r.y - PAD_Y, w: r.w + PAD_X * 2, h: r.h + PAD_Y * 2 };
}

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

/**
 * 부모 → 자식 연결선의 전체 기하.
 *
 * 인자는 **글자 사각형**을 받고, 안에서 패딩 상자로 부풀려 그 변에 앉힌다.
 * 호출부가 패딩을 신경 쓸 필요가 없다.
 */
export function linkGeometry(rawParent: Rect, rawChild: Rect): LinkGeometry {
  const parent = padded(rawParent);
  const child = padded(rawChild);
  const a0 = anchor(parent, center(child));
  const b0 = anchor(child, center(parent));
  const na = normal(a0.side);
  const nb = normal(b0.side);

  const a = { x: a0.x + na.x * END_GAP, y: a0.y + na.y * END_GAP };
  const b = { x: b0.x + nb.x * END_GAP, y: b0.y + nb.y * END_GAP };

  /**
   * **세로로 이어질 때는 왼쪽 홈통을 탄다** (D158, 사용자 지시 2026-08-03:
   * "연결선이 어색해 — 더 자연스럽게").
   *
   * 기본 앵커는 상대 중심을 향해 변 위를 미끄러진다. 카드가 넓어지면
   * (ITEM_W 560) 그 지점이 글 한가운데 밑이라, 선이 문단 아래에서 불쑥
   * 나와 다음 문단 한가운데로 들어간다 — 어느 글에서 어느 글로 가는지가
   * 아니라 "글을 가로지르는 선"으로 보인다.
   *
   * 왼쪽 끝(괘선이 있는 자리)에서 나와 왼쪽 끝으로 들어가면 트리의 등뼈가
   * 된다. 들여쓴 자식으로 갈 때는 짧은 S가 되어 갈라짐이 그대로 읽힌다.
   */
  const vertical =
    (a0.side === "bottom" || a0.side === "top") &&
    (b0.side === "top" || b0.side === "bottom");
  if (vertical) {
    a.x = parent.x + EDGE_INSET;
    b.x = child.x + EDGE_INSET;
  }

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
