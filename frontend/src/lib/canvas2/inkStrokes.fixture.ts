/**
 * 테스트가 쓰는 획 생성기 (D178). **제품 코드가 아니다** — 두 테스트 파일이
 * 같은 모양을 그려야 해서 여기 모았다(테스트 파일끼리 import하면 저쪽 describe가
 * 두 번 돈다).
 *
 * 모양은 **사람이 실제로 그리는 순서**를 흉내 낸다. 이상적인 도형으로 재면
 * 통과하는 규칙이 실물에서는 무너진다 — 화살촉의 되꺾임이 그랬다.
 */

import type { PenStroke } from "./penPad";

/** 점들을 이은 획. */
export function path(...pts: readonly (readonly [number, number])[]): PenStroke {
  return pts.map(([x, y]) => ({ x, y, p: 0.6 }));
}

/** 타원(또는 그 일부). `to`를 2π보다 작게 주면 벌어진 고리가 된다. */
export function oval(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  to = Math.PI * 2,
  from = 0,
  steps = 48,
): PenStroke {
  const out: PenStroke = [];
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t), p: 0.6 });
  }
  return out;
}

/**
 * 한 획으로 그린 화살표 — 몸통을 긋고 손을 안 떼고 촉을 그린다.
 *
 * 사람이 실제로 이렇게 그린다: 촉까지 갔다가 되돌아 나와 위 날개, 다시 촉,
 * 아래 날개. **끝점은 촉이 아니라 날개 끝**이라는 것이 판정의 핵심이다.
 */
export function hookArrow(
  ax: number, ay: number, bx: number, by: number,
): PenStroke {
  const [w1, w2] = wings(ax, ay, bx, by);
  return path([ax, ay], [bx, by], w1, [bx, by], w2);
}

/** 몸통과 촉을 따로 그린 화살표 — 획 셋. */
export function pieceArrow(
  ax: number, ay: number, bx: number, by: number,
): PenStroke[] {
  const [w1, w2] = wings(ax, ay, bx, by);
  return [path([ax, ay], [bx, by]), path([bx, by], w1), path([bx, by], w2)];
}

function wings(
  ax: number, ay: number, bx: number, by: number,
): [readonly [number, number], readonly [number, number]] {
  const d = Math.hypot(bx - ax, by - ay);
  const ux = (bx - ax) / d;
  const uy = (by - ay) / d;
  const back = Math.min(28, d * 0.18);
  const wing = back * 0.5;
  return [
    [bx - ux * back - uy * wing, by - uy * back + ux * wing],
    [bx - ux * back + uy * wing, by - uy * back - ux * wing],
  ];
}

/**
 * 손글씨 한 줄 — 짧은 획이 다닥다닥 붙어 줄을 이룬다.
 *
 * 한글 한 글자가 획 대여섯이고 하나하나가 짧다는 것이 요점이다. **이것이
 * 표시로 세어지면** 카드 옆에 질문을 쓴 것만으로 그 카드를 짚은 것이 된다.
 */
export function handwriting(
  x: number,
  y: number,
  glyphs: number,
  size = 34,
): PenStroke[] {
  const out: PenStroke[] = [];
  for (let g = 0; g < glyphs; g++) {
    const gx = x + g * (size * 1.25);
    // 글자 하나 = 가로획 둘 + 세로획 둘 + 짧은 사선 하나.
    out.push(path([gx, y], [gx + size, y + 2]));
    out.push(path([gx, y + size * 0.5], [gx + size, y + size * 0.5]));
    out.push(path([gx + size * 0.2, y], [gx + size * 0.2, y + size]));
    out.push(path([gx + size * 0.8, y + 4], [gx + size * 0.8, y + size]));
    out.push(path([gx + size * 0.3, y + size], [gx + size * 0.7, y + size * 0.7]));
  }
  return out;
}
