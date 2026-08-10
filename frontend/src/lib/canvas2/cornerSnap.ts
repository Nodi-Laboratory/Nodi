/**
 * 미니맵이 붙을 모서리 (D210 5-1).
 *
 * 자유 위치는 없다 — 손을 떼면 **네 모서리 중 가장 가까운 자리**로 감속하며
 * 붙는다. 자유롭게 두면 미니맵이 캔버스 한가운데 떠서 정작 캔버스를 가린다.
 *
 * ⚠️ "가장 가까운"은 **미니맵 중심과 각 모서리 기준점의 거리**로 판정한다.
 * 화면을 사분면으로 나눠 판정하면 가장자리에서 직관과 어긋난다 — 화면 왼쪽
 * 끝 한가운데에 둔 미니맵은 사분면으로는 위/아래가 종이 한 장 차이로 갈리지만,
 * 눈으로는 "왼쪽에 붙는다"가 먼저다.
 */

export type Corner = "tl" | "tr" | "bl" | "br";

/**
 * 붙을 수 있는 모서리.
 *
 * **좌상단이 2026-08-09에 돌아왔다** (사용자 지시). D211 9에서 뺐던 이유는
 * 거기 대화 목록·배율 버튼이 있어서 미니맵이 가려 버린다는 것이었는데, 그
 * 두 버튼을 걷어내면서 자리가 비었다 — 이제 네 모서리를 다 쓴다.
 *
 * 좌상단에 남은 것은 "어느 학급 어느 대화방"을 말하는 **글자 한 줄**이고,
 * 그건 `pointer-events: none`이라 미니맵을 못 가린다. 겹치면 크롬 규칙
 * (`chromeFit`)이 도구바를 비켜세운다.
 */
export const CORNERS: readonly Corner[] = ["tl", "tr", "bl", "br"];

export interface Viewport {
  w: number;
  h: number;
}

export interface Box {
  w: number;
  h: number;
}

/** 모서리에서 띄우는 여백(px). 화면 끝에 딱 붙으면 잘린 것처럼 보인다. */
export const SNAP_MARGIN = 16;

/**
 * 그 모서리에 붙었을 때의 좌상단 좌표.
 *
 * `topInset`은 **위쪽에 이미 뭔가 떠 있는 높이**다 (2026-08-10). 상단 바가
 * 캔버스 위로 올라오면서(사용자 지시: 바 뒤로 캔버스가 보이게) 위 두 모서리가
 * 그 바에 가리게 됐다 — 예전에는 바가 한 줄을 차지해 이 문제가 없었다(D218).
 *
 * 바 높이를 여기서 상수로 박지 않고 **받는다.** 문구가 한 줄 늘거나 크롬 배율이
 * 바뀌면 높이가 달라지는데, 박아 두면 그 숫자는 반드시 어긋난다.
 */
export function cornerPos(
  corner: Corner,
  vp: Viewport,
  box: Box,
  topInset = 0,
): { x: number; y: number } {
  const right = Math.max(SNAP_MARGIN, vp.w - box.w - SNAP_MARGIN);
  const bottom = Math.max(SNAP_MARGIN, vp.h - box.h - SNAP_MARGIN);
  // 위 여백이 화면을 다 먹으면(아주 낮은 화면) 아래 여백보다 커질 수 있다 —
  // 그때는 붙일 자리가 없으므로 아래 한계를 넘지 않게 묶는다.
  const top = Math.min(bottom, SNAP_MARGIN + topInset);
  switch (corner) {
    case "tl":
      return { x: SNAP_MARGIN, y: top };
    case "tr":
      return { x: right, y: top };
    case "bl":
      return { x: SNAP_MARGIN, y: bottom };
    default:
      return { x: right, y: bottom };
  }
}

/**
 * 지금 자리에서 **가장 가까운 모서리**.
 *
 * `at`은 미니맵의 좌상단이다. 중심끼리 견주므로 상자 크기를 함께 받는다.
 */
export function nearestCorner(
  at: { x: number; y: number },
  vp: Viewport,
  box: Box,
  topInset = 0,
): Corner {
  const cx = at.x + box.w / 2;
  const cy = at.y + box.h / 2;
  let best: Corner = "br";
  let bestD = Infinity;
  for (const c of CORNERS) {
    const p = cornerPos(c, vp, box, topInset);
    const d = Math.hypot(p.x + box.w / 2 - cx, p.y + box.h / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
