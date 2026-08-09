/**
 * 세모·별 (사용자 지시 2026-08-09).
 *
 * ## Excalidraw에는 이 도구가 **없다**
 *
 * 저쪽이 주는 도형은 사각형·마름모·원·화살표·선뿐이다. 그래서 세모와 별은
 * **닫힌 선(line)**으로 만든다 — 꼭짓점을 우리가 찍고, 첫 점으로 되돌아와
 * 닫는다. 도형으로 태어난 것이 아니라 선이 도형 모양을 하고 있는 것이라,
 * 저쪽의 "도형 채우기" 같은 기능은 안 따라온다. 대신 옮기기·크기 바꾸기·
 * 지우기·올가미는 다른 요소와 똑같이 된다(선도 요소다).
 *
 * ## 좌표는 **상자에 맞춘다**
 *
 * 학생은 끌어서 크기를 정한다. 그 사각형 안에 꼭 맞는 도형을 그리는 것이
 * 여기 함수들의 일이다 — 점은 상자의 왼쪽 위(0,0) 기준 상대 좌표이고,
 * Excalidraw의 `line`이 그렇게 받는다.
 */

/** 우리가 직접 그리는 도형. Excalidraw에 같은 이름의 도구가 없다. */
export type PolyKind = "triangle" | "star";

/** 별의 뾰족한 끝 수. 다섯이 "별"로 읽히는 가장 흔한 모양이다. */
const STAR_POINTS = 5;

/**
 * 별의 안쪽 반지름 비율.
 *
 * 0.5면 통통하고 0.3이면 가시처럼 뾰족하다. 0.382는 정오각별(꼭짓점을 하나
 * 걸러 이은 별)의 비율이라 손으로 그린 별과 가장 비슷하게 읽힌다.
 */
const STAR_INNER = 0.382;

/**
 * 상자 안에 꼭 맞는 도형의 꼭짓점.
 *
 * 반환값의 첫 점은 언제나 `[0,0]`이 아닐 수 있다 — 도형이 상자를 채우는 것이
 * 먼저고, 원점은 Excalidraw가 요소의 x·y로 따로 갖는다. **마지막에 첫 점을
 * 다시 넣어 닫는다**: 안 닫으면 별이 획 하나로 끊겨 보인다.
 */
export function polygonPoints(kind: PolyKind, w: number, h: number): [number, number][] {
  const W = Math.max(1, Math.abs(w));
  const H = Math.max(1, Math.abs(h));

  if (kind === "triangle") {
    // 밑변이 상자의 아래, 꼭대기가 위 가운데 — 가장 흔한 세모다.
    return [
      [W / 2, 0],
      [W, H],
      [0, H],
      [W / 2, 0],
    ];
  }

  // 별 — 바깥 점과 안쪽 점을 번갈아 찍는다. 위쪽 꼭짓점이 정면이어야 하므로
  // 시작 각도를 −90°로 둔다(그냥 0에서 시작하면 별이 옆으로 누워 뜬다).
  const raw: [number, number][] = [];
  for (let i = 0; i < STAR_POINTS * 2; i++) {
    const r = i % 2 === 0 ? 1 : STAR_INNER;
    const a = -Math.PI / 2 + (Math.PI * i) / STAR_POINTS;
    raw.push([Math.cos(a) * r, Math.sin(a) * r]);
  }

  /**
   * ⚠️ **원에 그린 뒤 상자에 다시 맞춘다.**
   *
   * 별의 자기 상자는 원이 아니다 — 다섯 꼭짓별은 가로로 ±0.951, 세로로 −1 …
   * +0.809만 뻗는다. 원을 그대로 상자에 맞추면 학생이 끈 사각형 안에서
   * 별이 **가로 4.9% 모자라고 아래가 뜬 채로** 앉는다(실측: 100 상자에
   * 폭 95.1). 그리는 사람의 약속은 "끈 만큼"이다.
   */
  const xs = raw.map((p) => p[0]);
  const ys = raw.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const sx = W / (Math.max(...xs) - x0);
  const sy = H / (Math.max(...ys) - y0);
  const pts: [number, number][] = raw.map(([x, y]) => [(x - x0) * sx, (y - y0) * sy]);
  pts.push(pts[0]);
  return pts;
}
