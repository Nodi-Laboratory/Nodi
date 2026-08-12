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
/**
 * "같은 줄기"로 볼 가로 어긋남 (world px, D206).
 *
 * 트리의 자식은 부모 바로 아래 같은 x에 놓이고, 갈라질 때만 들여쓴다
 * (`layout.ts`의 SIB_GAP 200). 그보다 크게 벌어진 것은 옆 열이거나 멀리
 * 떨어진 카드라, 세로줄로 이으면 화면을 가로지르는 긴 직선이 된다.
 */
export const SAME_COLUMN_TOL = 240;

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

  /**
   * **자식이 아래에 있으면 언제나 왼쪽 세로줄로 잇는다** (D206).
   *
   * 예전에는 양쪽 앵커가 각자 "상대 중심을 향한 변"을 고르고, 그 둘이 **다
   * 위아래일 때만** 왼쪽 홈통으로 옮겼다(D158). 그런데 카드가 만들어지는
   * 중에는 그 조건이 성립하지 않는다 — 자식이 아직 짧아 부모 쪽 앵커가
   * 옆(오른쪽)으로 잡히고, 그러면 끝점이 **부모 중심 축**에서 내려온다.
   * 글이 채워져 상자가 커지면 그제야 조건이 참이 되어 끝점이 왼쪽으로
   * 훌쩍 옮겨 간다 — 사용자가 "어색하다"고 한 그 움직임이다(2026-08-07).
   *
   * 아래로 가는 관계는 **처음부터** 세로다. 상자 크기와 무관하게 판정되므로
   * 글이 자라도 끝점이 움직이지 않는다.
   */
  const straightDown =
    child.y >= parent.y + parent.h - EDGE_INSET &&
    Math.abs(child.x - parent.x) <= SAME_COLUMN_TOL;
  if (straightDown) {
    const ax = parent.x + EDGE_INSET;
    const bx = child.x + EDGE_INSET;
    const a = { x: ax, y: parent.y + parent.h + END_GAP };
    const b = { x: bx, y: child.y - END_GAP };
    const bow = clamp(Math.hypot(b.x - a.x, b.y - a.y) * 0.42, 36, 190);
    return {
      a,
      b,
      c1: { x: a.x, y: a.y + bow },
      c2: { x: b.x, y: b.y - bow },
      sideA: "bottom",
      sideB: "top",
    };
  }

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

/* ═══════════════════ 고정 포트 연결선 (D211, D210 4단계) ═══════════════════
 *
 * ## 앵커를 고정한다
 *
 * 예전에는 앵커가 두 카드의 상대 위치를 보고 변 위를 미끄러졌다(위 `anchor`).
 * 그러면 카드를 옮길 때마다 선이 나가는 자리가 바뀌어, 학생이 "이 카드에서
 * 나가는 선"을 눈으로 좇기 어렵다. 이제 자리는 **둘뿐이고 안 움직인다**:
 *
 *     위 변 중앙   부모로 올라가는 선 — 부모는 하나뿐이라 선도 하나다
 *     아래 변 중앙 자식으로 내려가는 선 — 자식은 여럿이고 전부 여기서 나간다
 *
 * 좌우 변에는 포트가 없다. 띄우지도 않는다 — 끌 수 없는 점을 보여 주면
 * 학생이 거기서 끌어 보고 안 되는 것을 결함으로 읽는다.
 *
 * ## 그래서 겹침을 다시 풀어야 한다
 *
 * 앵커가 고정이던 시절에 정확히 이 문제가 있었다("같은 부모의 답 둘이 한 점에서
 * 나가 선이 겹쳤다") — 그래서 상대 위치로 바꿨던 것이다. 이번에는 자리를
 * 일부러 고정하니 그때 포기했던 문제를 다시 풀어야 한다:
 *
 *   1. **공유 줄기** — 아래 포트에서 수직으로 조금 내려온다. 그 구간은
 *      모든 자식이 함께 쓴다.
 *   2. **갈라짐** — 줄기 끝에서 각자 목적지로 벌어진다. 벌리는 폭은 자식
 *      수에 따라 커진다(고정 각도면 많을 때 다시 겹친다).
 */

/** 아래 포트에서 수직으로 내려오는 공유 줄기의 길이(world px). */
export const PORT_STEM = 24;
/**
 * 갈라질 때 이웃 사이의 가로 간격(world px).
 *
 * 자식이 둘이면 좁게, 넷이면 넓게 — 자식 수와 무관한 고정 각도를 쓰면 많을 때
 * 다시 겹친다. 곱이 아니라 합으로 키우는 이유는, 곱하면 자식이 여섯쯤 될 때
 * 부채가 카드 폭을 넘어 옆 열까지 뻗기 때문이다.
 */
export function fanStep(count: number): number {
  return count <= 1 ? 0 : 26 + 8 * Math.min(count - 2, 6);
}

/** 부모의 **아래 포트** — 자식으로 내려가는 선이 나가는 유일한 자리. */
export function portFrom(rawParent: Rect): Point {
  const r = padded(rawParent);
  return { x: r.x + r.w / 2, y: r.y + r.h };
}

/** 자식의 **위 포트** — 부모로 올라가는 선이 들어오는 유일한 자리. */
export function portTo(rawChild: Rect): Point {
  const r = padded(rawChild);
  return { x: r.x + r.w / 2, y: r.y };
}

export interface PortLink {
  /** 부모 아래 포트. */
  a: Point;
  /** 공유 줄기의 끝 — 여기서부터 갈라진다. */
  stem: Point;
  /** 자식 위 포트. */
  b: Point;
  c1: Point;
  c2: Point;
}

/**
 * 부모 → 자식 한 가닥.
 *
 * @param index 같은 부모의 자식 중 몇 번째인가(가로 순서)
 * @param count 그 부모의 자식 수
 */
export function linkPath(
  parent: Rect,
  child: Rect,
  index = 0,
  count = 1,
): PortLink {
  const a = portFrom(parent);
  const b = portTo(child);
  const stem = { x: a.x, y: a.y + PORT_STEM };

  // 줄기 끝에서 바로 벌어진다. 가운데를 0으로 두고 좌우 대칭으로 민다.
  const spread = (index - (count - 1) / 2) * fanStep(count);
  const drop = Math.max(1, b.y - stem.y);
  return {
    a,
    stem,
    b,
    // 첫 제어점은 **줄기 방향(아래)** 을 이어받되 갈라지는 쪽으로 민다.
    c1: { x: stem.x + spread, y: stem.y + drop * 0.4 },
    // 끝 제어점은 자식 위 포트로 **수직으로** 들어오게 잡는다.
    c2: { x: b.x, y: b.y - drop * 0.4 },
  };
}

/* ═══════════════ 곁들이(사진·영상)의 연결선 (사용자 지시 2026-08-12) ═══════════
 *
 * 트리 간선은 포트가 **고정**이다 — 아래로 나가고 위로 들어온다. 그 규칙이
 * 사는 이유는 트리가 세로로 자라기 때문이다: 자리가 고정이라 학생이 "이
 * 카드에서 나가는 선"을 눈으로 좇을 수 있다(위 D211 주석).
 *
 * **사진·영상 상자는 트리 노드가 아니다.** 카드의 왼쪽에도, 오른쪽에도,
 * 위아래에도 붙는다(`layout.ts` — 오른쪽이 차면 왼쪽으로 간다). 그런데 아래
 * 포트에 묶여 있던 탓에, 오른쪽에 나란히 붙은 상자로 가는 선이 카드 밑으로
 * 한참 내려갔다가 되올라왔다. 짧은 거리를 긴 곡선이 잇는 셈이라 "왜 저기로
 * 도나" 싶은 그림이 된다.
 *
 * 그래서 곁들이는 **네 변의 중앙 여덟 자리 중 가장 가까운 한 쌍**으로 잇는다
 * (사용자 지시: "좌우상하 변의 중심 … 그 선의 길이가 최소가 되는 시작점과
 * 끝점"). 트리처럼 자리를 고정할 이유가 없다 — 상자는 카드의 제약을 안 받고,
 * 학생이 좇을 등뼈도 여기엔 없다.
 */

/** 네 변의 중앙(패딩 상자 기준)과 그 바깥 방향. */
export function edgeMidpoints(raw: Rect): (Point & { side: Side })[] {
  const r = padded(raw);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  // 순서가 곧 동점일 때의 우선순위다 — 좌우가 먼저다. 곁들이는 카드 **옆**에
  // 놓이는 것이 기본이라(layout.ts), 정확히 대각일 때 옆으로 붙는 편이 자연스럽다.
  return [
    { x: r.x + r.w, y: cy, side: "right" },
    { x: r.x, y: cy, side: "left" },
    { x: cx, y: r.y + r.h, side: "bottom" },
    { x: cx, y: r.y, side: "top" },
  ];
}

/**
 * 곁들이 한 가닥 — **가장 짧은 변-중앙 쌍**.
 *
 * 돌려주는 모양은 `linkPath`와 같은 `PortLink`다. 그리는 쪽·끄는 쪽이 두 종류를
 * 구분하지 않아도 되게 하려는 것이다 — 구분해야 하면 한쪽만 고치는 날이 온다.
 * 줄기는 없다(`stem = a`): 공유할 형제가 없으니 나눠 쓸 구간도 없다.
 */
export function attachPath(rawParent: Rect, rawChild: Rect): PortLink {
  const as = edgeMidpoints(rawParent);
  const bs = edgeMidpoints(rawChild);

  let best = { a: as[0], b: bs[0], d: Infinity };
  for (const a of as) {
    for (const b of bs) {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      // 엄격 비교라 동점이면 **먼저 온 것**이 이긴다(위 순서 주석).
      if (d < best.d) best = { a, b, d };
    }
  }

  const na = normal(best.a.side);
  const nb = normal(best.b.side);
  const a = { x: best.a.x + na.x * END_GAP, y: best.a.y + na.y * END_GAP };
  const b = { x: best.b.x + nb.x * END_GAP, y: best.b.y + nb.y * END_GAP };

  // 곁들이는 바로 옆에 붙는다 — 트리 간선만큼 부풀리면 짧은 거리에서 곡선이
  // 크게 휘어 도로 카드 위를 지난다. 거리에 묶되 상한을 낮게 잡는다.
  const bow = clamp(Math.hypot(b.x - a.x, b.y - a.y) * 0.34, 18, 88);
  return {
    a,
    stem: a,
    b,
    c1: { x: a.x + na.x * bow, y: a.y + na.y * bow },
    c2: { x: b.x + nb.x * bow, y: b.y + nb.y * bow },
  };
}

/**
 * 손이 닿는 **넓은 투명 선**의 path — 줄기를 뺀 갈라짐 구간만 (D211 3).
 *
 * SVG의 기본 히트 판정은 그려진 획뿐이라 2.6px 선을 정확히 맞춰야 hover가
 * 뜬다. 사실상 못 맞춘다(사용자 보고: "연결선에 가져가도 ✕가 안 뜬다").
 * 그래서 같은 곡선을 굵게 한 번 더 그리고 투명하게 둔다.
 *
 * **줄기는 뺀다.** 여러 자식의 선이 그 구간을 공유하므로, 거기서 잡히면
 * 어느 연결을 끊는지 가릴 수 없다(D210 4-4의 근거는 여기 그대로 산다).
 */
export function hitPathD(g: PortLink): string {
  return `M ${g.stem.x} ${g.stem.y} C ${g.c1.x} ${g.c1.y} ${g.c2.x} ${g.c2.y} ${g.b.x} ${g.b.y}`;
}

/** SVG path 문자열 — 줄기(직선) + 갈라짐(곡선). */
export function linkPathD(g: PortLink): string {
  return (
    `M ${g.a.x} ${g.a.y} L ${g.stem.x} ${g.stem.y} ` +
    `C ${g.c1.x} ${g.c1.y} ${g.c2.x} ${g.c2.y} ${g.b.x} ${g.b.y}`
  );
}

/** 갈라진 뒤 곡선 위의 한 점(0=줄기 끝, 1=자식). 라벨·✕ 자리에 쓴다. */
export function pointOnFan(g: PortLink, t: number): Point {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * g.stem.x + w1 * g.c1.x + w2 * g.c2.x + w3 * g.b.x,
    y: w0 * g.stem.y + w1 * g.c1.y + w2 * g.c2.y + w3 * g.b.y,
  };
}

/**
 * ✕(끊기 버튼)가 앉을 자리.
 *
 * **갈라진 구간의 한가운데다**(사용자 지시 2026-08-08: "마우스가 연결선에
 * 닿자마자 그 연결선의 중앙에 ✕가 보여야 한다").
 *
 * 처음에는 0.78(자식 쪽)이었다. 근거는 "자식의 위 포트에는 선이 하나뿐이라
 * 절대 안 겹친다"였는데, **그 근거는 히트 판정이 선 자체일 때의 이야기**다.
 * 이제 넓은 투명 선이 손을 받고 그 선이 줄기를 빼고 시작하므로, 어느 선을
 * 짚었는지는 히트 선이 이미 가른다 — ✕는 눈이 먼저 가는 자리에 있으면 된다.
 *
 * ⚠️ 줄기(공유 구간)에는 여전히 두지 않는다. `pointOnFan`이 0에서 시작하는
 * 지점이 **줄기 끝**이라, 0.5는 언제나 갈라진 뒤다.
 */
export const CUT_AT = 0.5;

export function cutPoint(g: PortLink): Point {
  return pointOnFan(g, CUT_AT);
}
