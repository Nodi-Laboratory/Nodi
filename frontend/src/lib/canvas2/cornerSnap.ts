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
 * ## 위 모서리는 **화면 위 변에 붙는다** (사용자 지시 2026-08-11)
 *
 * 2026-08-10에는 상단 바 높이(`topInset`)만큼 내려앉았다. 그때 바는 화면
 * 폭을 가로지르는 띠라 피할 도리가 없었기 때문이다. 지금 바는 **왼쪽의
 * 알약 하나**라 옆으로 비켜설 수 있고(`chromeFit.crumbDx`), 그래서 지도가
 * 위 변에 딱 붙는다 — 비켜서는 쪽이 뒤집혔다.
 *
 * ⚠️ **여기와 `chromeFit`이 같은 자리를 봐야 한다.** 한쪽만 고치면 계산이
 * 보는 지도 자리와 화면의 지도 자리가 갈려서, 겹치는데 안 겹친다고 하거나
 * 그 반대가 된다.
 */
export function cornerPos(
  corner: Corner,
  vp: Viewport,
  box: Box,
): { x: number; y: number } {
  const right = Math.max(SNAP_MARGIN, vp.w - box.w - SNAP_MARGIN);
  const bottom = Math.max(SNAP_MARGIN, vp.h - box.h - SNAP_MARGIN);
  // 아주 낮은 화면에서는 위 여백이 아래 한계를 넘을 수 있다 — 그때는 붙일
  // 자리가 없으므로 아래 한계로 묶는다.
  const top = Math.min(bottom, SNAP_MARGIN);
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
): Corner {
  const cx = at.x + box.w / 2;
  const cy = at.y + box.h / 2;
  let best: Corner = "br";
  let bestD = Infinity;
  for (const c of CORNERS) {
    const p = cornerPos(c, vp, box);
    const d = Math.hypot(p.x + box.w / 2 - cx, p.y + box.h / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
