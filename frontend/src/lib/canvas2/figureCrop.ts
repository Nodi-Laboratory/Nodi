/**
 * 도판의 `object-contain` 레터박스 좌표 변환 (D178).
 *
 * `FigureItem`의 `<img>`는 `object-contain` + `max-h-64`라, **아이템 상자와
 * 그림이 실제로 그려지는 영역이 다르다** — 세로로 긴 도판은 좌우에, 가로로
 * 긴 도판은 위아래에 빈 띠가 생긴다.
 *
 * 이걸 무시하고 아이템 rect에 그대로 매핑하면 학생이 그린 동그라미가 그림의
 * 엉뚱한 데 얹힌다. **그런데 결과물은 그럴싸한 그림이라 눈으로는 안 잡힌다** —
 * 그래서 순수 함수로 빼고 테스트로 못 박는다(D126·penPad와 같은 이유).
 *
 * 쓰이는 곳은 도판 확대본이다: 학생의 표시를 도판 자신의 픽셀 좌표로 옮겨
 * 원본 해상도 그림 위에 같은 자리로 다시 그린다.
 */

import type { Rect } from "./rect";

/**
 * 상자 안에서 그림이 실제로 차지하는 영역.
 *
 * 자연 크기를 모르면(비트맵을 못 받았다) 상자를 그대로 준다 — 0으로 나누지
 * 않기 위해서다. 그 경우 호출부는 어차피 그림을 안 그린다.
 */
export function containRect(box: Rect, naturalW: number, naturalH: number): Rect {
  if (!(naturalW > 0) || !(naturalH > 0)) return box;
  const scale = Math.min(box.w / naturalW, box.h / naturalH);
  const w = naturalW * scale;
  const h = naturalH * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/**
 * 월드 좌표 → 그림 자체의 픽셀 좌표. 그림 밖(띠 위·상자 밖)이면 null.
 *
 * **null을 그냥 버리지 말 것** — 획 하나가 그림 안팎을 오가면 안쪽 구간만
 * 이어 그려야 한다. 밖의 점을 가장자리로 뭉개면 없는 획이 생긴다.
 */
export function worldToFigure(
  x: number,
  y: number,
  box: Rect,
  naturalW: number,
  naturalH: number,
): { x: number; y: number } | null {
  const r = containRect(box, naturalW, naturalH);
  if (!(r.w > 0) || !(r.h > 0)) return null;
  const fx = ((x - r.x) / r.w) * naturalW;
  const fy = ((y - r.y) / r.h) * naturalH;
  if (fx < 0 || fy < 0 || fx > naturalW || fy > naturalH) return null;
  return { x: fx, y: fy };
}
