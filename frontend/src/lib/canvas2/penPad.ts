/**
 * 펜 입력판 기하 (D176).
 *
 * 프롬프트창에 **손으로 써서 묻는 길**. 자판이 느린 학생, 수식·기호를 자판으로
 * 어떻게 치는지 모르는 학생이 걸리는 지점이 여기다.
 *
 * ## 화면에 그리는 것과 OCR로 보내는 것은 같은 획이다
 *
 * 이 파일이 존재하는 이유다. 미리보기와 전송본을 따로 그리면 "분명 이렇게
 * 썼는데 왜 저렇게 읽혔지"를 아무도 못 쫓는다 — 렌더는 `drawStrokes` 하나,
 * 전송본은 그 함수를 **다른 배율·다른 배경**으로 한 번 더 부를 뿐이다.
 *
 * ## 기하는 컴포넌트가 아니라 여기에 둔다
 *
 * D126과 같은 이유다. 획 다듬기·경계 계산·배율 결정은 눈으로 검증할 수 없다
 * (틀려도 그럴싸한 그림이 나온다). `penPad.test.ts`가 못 박는다.
 */

import type { Rect } from "./rect";

/** 필압을 아는 입력(스타일러스)만 p가 의미 있다. 마우스·손가락은 NO_PRESSURE. */
export interface InkPoint {
  x: number;
  y: number;
  /** 0~1. */
  p: number;
}

export type PenStroke = InkPoint[];

/**
 * 필압을 못 주는 입력의 기본값.
 *
 * 0.5가 아니라 조금 위다 — 마우스로 쓴 글씨는 필압 변화가 없어 얇으면 획이
 * 끊겨 보이고, OCR도 가는 획을 잘 놓친다.
 */
export const NO_PRESSURE = 0.62;

/** 기본 획 굵기(CSS px). 필압이 이 값을 위아래로 흔든다. */
export const BASE_WIDTH = 2.8;

/**
 * 잉크 색 — **검정**(사용자 지시 2026-08-04).
 *
 * 캔버스 아이템의 "학생 = 틸"(D120)은 여기 적용되지 않는다. 그 색은 **누가
 * 만든 것인지**를 나타내는 표시인데, 이 판은 만들어진 물건이 아니라 글을 쓰는
 * 종이다. 그리고 이 상수 하나를 화면과 전송본이 같이 쓰므로 **보이는 획과
 * 보내는 획의 색이 갈릴 수 없다.**
 */
export const INK_COLOR = "#111111";

/**
 * 점 솎기 간격(CSS px).
 *
 * 스타일러스는 240Hz까지 올라온다 — 전부 담으면 한 획이 수천 점이 되고,
 * 그 대부분은 같은 자리의 떨림이라 획을 지저분하게 만든다.
 */
export const MIN_STEP = 1.1;

/**
 * "글씨를 썼다"고 볼 최소 획 길이(CSS px).
 *
 * 펜을 톡 놓거나 손바닥이 스친 것으로 OCR을 부르면, 학생은 아무것도 안 썼는데
 * 오류 문구만 본다. 획 길이 합이 이보다 짧으면 **부르지 않는다.**
 */
export const MIN_INK = 40;

/** 전송본 여백(획 좌표계 px). OCR은 글자가 가장자리에 붙으면 잘 못 읽는다. */
export const EXPORT_PAD = 18;

/** 전송본 한 변 상한(px). 넘으면 배율을 줄인다 — 업로드 크기와 모델 입력 상한. */
export const MAX_EXPORT_SIDE = 1600;

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return NO_PRESSURE;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 필압 → 획 굵기.
 *
 * 0.55배~1.45배. 아래를 0으로 열어 두면 살짝 뗀 구간에서 획이 사라져 글자가
 * 끊긴 것처럼 보인다 — OCR에는 끊긴 획이 다른 글자다.
 */
export function penWidth(pressure: number, base = BASE_WIDTH): number {
  return base * (0.55 + 0.9 * clamp01(pressure));
}

/** 이 점을 획에 더할 가치가 있나(직전 점과 MIN_STEP 이상 떨어졌나). */
export function shouldAppend(
  last: InkPoint | undefined,
  next: InkPoint,
  minStep = MIN_STEP,
): boolean {
  if (!last) return true;
  return Math.hypot(next.x - last.x, next.y - last.y) >= minStep;
}

/** 획 하나의 경로 길이. */
export function strokeLength(stroke: PenStroke): number {
  let sum = 0;
  for (let i = 1; i < stroke.length; i++) {
    sum += Math.hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y);
  }
  return sum;
}

/** 모든 획의 길이 합. */
export function inkLength(strokes: readonly PenStroke[]): number {
  let sum = 0;
  for (const s of strokes) sum += strokeLength(s);
  return sum;
}

/** OCR을 부를 만큼 썼나. */
export function hasInk(strokes: readonly PenStroke[], min = MIN_INK): boolean {
  return inkLength(strokes) >= min;
}

/**
 * 획 전체를 감싸는 사각형. 굵기의 **절반**을 사방에 더한다 —
 * 점 좌표만 재면 획의 바깥쪽 절반이 잘려 나간다.
 */
export function inkBounds(
  strokes: readonly PenStroke[],
  base = BASE_WIDTH,
): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let seen = false;
  for (const s of strokes) {
    for (const pt of s) {
      const r = penWidth(pt.p, base) / 2;
      if (pt.x - r < x0) x0 = pt.x - r;
      if (pt.y - r < y0) y0 = pt.y - r;
      if (pt.x + r > x1) x1 = pt.x + r;
      if (pt.y + r > y1) y1 = pt.y + r;
      seen = true;
    }
  }
  if (!seen) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 전송본 상자 = 경계 + 여백.
 *
 * **입력판 크기로 자르지 않는다.** 전송본은 새로 그리는 흰 종이라 판 밖도
 * 여백일 뿐이고, 가장자리에 쓴 글씨도 사방 여백을 똑같이 받는다.
 */
export function exportBox(bounds: Rect, pad = EXPORT_PAD): Rect {
  return {
    x: bounds.x - pad,
    y: bounds.y - pad,
    w: bounds.w + pad * 2,
    h: bounds.h + pad * 2,
  };
}

/**
 * 전송본 배율.
 *
 * 화면 배율(dpr)만큼 키워 획을 또렷하게 보내되 상한을 넘기지 않고, 한 변이
 * `maxSide`를 넘으면 그만큼 줄인다. 가로로 길게 쓴 글씨가 이 갈래를 탄다.
 *
 * ⚠️ **여기 들어오는 `box`는 월드 좌표다** — 카메라 배율이 안 섞여 있다.
 * 그래서 호출부는 `dpr × 카메라 배율`을 넘긴다(2026-08-10). 안 넘기면
 * 확대해서 쓴 글씨가 **그만큼 흐리게** 나간다: 화면에서 같은 크기로 써도
 * 확대 중이면 그 획이 덮는 월드 거리는 배율만큼 짧으므로 그림이 작아진다.
 * 실측 — 같은 손동작이 배율 1에서 255×91, 2.3배 확대에서 111×56.
 *
 * 상한이 2에서 3으로 올랐다. 학생이 세 배로 당겨 놓고 쓰면 눈에는 세 배로
 * 보이는 글씨이고, 그 해상도로 보내야 본 대로 읽힌다. `maxSide`가 여전히
 * 위를 막으므로 그림이 무한정 커지지는 않는다.
 */
export function exportScale(
  box: Rect,
  dpr: number,
  maxSide = MAX_EXPORT_SIDE,
): number {
  const want = Math.min(Math.max(Number.isFinite(dpr) ? dpr : 1, 1), 3);
  const longest = Math.max(box.w, box.h, 1);
  return Math.max(0.25, Math.min(want, maxSide / longest));
}

/**
 * 획을 2D 컨텍스트에 그린다.
 *
 * 중점 이차 보간이다 — 점을 직선으로 이으면 천천히 쓴 글씨에서 각이 보인다.
 * 굵기가 점마다 다르므로 **구간마다 path를 새로 연다**(한 path에 lineWidth는
 * 하나뿐이다). 구간이 짧아 겹치는 둥근 캡이 이음매를 메운다.
 *
 * 좌표 변환(배율·오프셋)은 호출부가 `ctx.setTransform`으로 건다 — 여기서
 * 좌표를 손대면 화면과 전송본의 기하가 갈린다.
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly PenStroke[],
  opts: { color?: string; base?: number } = {},
): void {
  const color = opts.color ?? INK_COLOR;
  const base = opts.base ?? BASE_WIDTH;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    // 점 하나는 선이 될 수 없다 — 점을 찍는다(마침표·획 시작의 톡).
    if (stroke.length === 1) {
      const pt = stroke[0];
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, penWidth(pt.p, base) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    let fx = stroke[0].x;
    let fy = stroke[0].y;
    for (let i = 1; i < stroke.length; i++) {
      const cur = stroke[i];
      const prev = stroke[i - 1];
      // 마지막 구간은 실제 끝점까지, 나머지는 다음 점과의 중점까지.
      const last = i === stroke.length - 1;
      const tx = last ? cur.x : (prev.x + cur.x) / 2;
      const ty = last ? cur.y : (prev.y + cur.y) / 2;
      ctx.beginPath();
      ctx.lineWidth = penWidth((prev.p + cur.p) / 2, base);
      ctx.moveTo(fx, fy);
      ctx.quadraticCurveTo(prev.x, prev.y, tx, ty);
      ctx.stroke();
      fx = tx;
      fy = ty;
    }
  }
  ctx.restore();
}

/**
 * 전송본 PNG를 만든다 — **흰 종이에 검은 획**.
 *
 * 입력판의 종이색(`--c-paper`)과 괘선은 담지 않는다. 배경 무늬는 OCR에
 * 노이즈이고, 테마가 어두우면 흰 글씨를 보내게 된다.
 *
 * 브라우저 전용(canvas·document). 획이 없으면 null.
 */
export async function renderInkPng(
  strokes: readonly PenStroke[],
  dpr = 1,
  /**
   * 지금 카메라 배율. 획은 월드 좌표라 **이것을 안 넣으면 확대해서 쓴
   * 글씨가 흐리게 나간다**(`exportScale` 머리말).
   */
  zoom = 1,
): Promise<Blob | null> {
  const bounds = inkBounds(strokes);
  if (!bounds) return null;
  const box = exportBox(bounds);
  const scale = exportScale(box, dpr * (zoom > 0 ? zoom : 1));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box.w * scale));
  canvas.height = Math.max(1, Math.round(box.h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  drawStrokes(ctx, strokes);  // 화면과 같은 INK_COLOR

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
