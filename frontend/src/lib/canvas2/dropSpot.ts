/**
 * 딸릴 카드가 없을 때 자료를 놓을 자리 (D210 7-1 C).
 *
 * "이미지만 추천해줘"인데 고른 카드도 없으면 곁들이가 붙을 데가 없다. 부모를
 * 안 주면 태그 없는 열(UNTAGGED)로 가는데, 그 열은 태그 열들 **뒤**라 카드에서
 * COL_GAP(760) 넘게 떨어진다 — 학생 눈에는 검색은 됐는데 아무것도 안 뜬 것과
 * 같다(D163이 이미 겪은 그것이다). 그래서 **지금 보고 있는 자리**에 놓는다.
 *
 * ## 겹치면 아래로 내려간다
 *
 * 무겹침은 이 캔버스에서 알고리즘의 성질이지 우연이 아니다(D123). 여기서도
 * 수렴을 기대하지 않는다 — 빈칸을 찾을 때까지 **정해진 걸음으로** 내려가고,
 * 걸음 수에 상한을 둔다. 상한에 닿으면 그냥 그 자리를 준다: 자리를 못 찾아
 * 아무것도 안 놓는 것보다 겹쳐서라도 보이는 편이 낫다.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 자리 하나가 실패했을 때 내려가는 걸음(px). */
const STEP = 60;
/** 걸음 상한. 카드가 빽빽해도 여기서 멈춘다. */
const MAX_STEPS = 40;

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

/**
 * 화면 가운데 근처의 빈 자리 `count`개.
 *
 * 자리를 하나 정할 때마다 **그 자리도 장애물에 넣는다** — 안 그러면 같은
 * 빈칸에 전부 겹쳐 쌓인다.
 */
export function dropSpots(
  center: { x: number; y: number },
  count: number,
  size: { w: number; h: number },
  rects: readonly Rect[],
  gap = 48,
): { x: number; y: number }[] {
  const taken: Rect[] = [...rects];
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    // 가로로는 한 장씩 오른쪽으로 — 세로로만 쌓으면 기둥이 된다(D163).
    const x = center.x - size.w / 2 + i * (size.w + gap);
    let y = center.y - size.h / 2;
    for (let s = 0; s < MAX_STEPS; s++) {
      const box = { x, y, w: size.w, h: size.h };
      if (!taken.some((r) => overlaps(box, r, gap))) break;
      y += STEP;
    }
    out.push({ x, y });
    taken.push({ x, y, w: size.w, h: size.h });
  }
  return out;
}
