/**
 * VLM에 보낼 도식을 그린다 (D178).
 *
 * ## 화면 캡처가 아니다
 *
 * `html2canvas`류를 버린 **결정적인 이유는 뷰포트다** — 패딩으로 끌어온 카드가
 * 화면 밖에 있으면 캡처할 방법이 없는데, 카드를 끌어오는 기준은 "획 주변"이지
 * "화면 안"이 아니다(축소해서 보다가 화살표를 그으면 대상 카드가 화면 밖일 수
 * 있다). 도식은 월드 좌표로 그리므로 그 문제가 성립하지 않는다.
 *
 * 부수 효과가 둘 더 있다. **다른 펜으로 그린 그림 제거가 공짜다**(그릴 것만
 * 그리므로), 그리고 자체 호스팅 손글씨 woff2를 인라인할 일이 없다.
 *
 * ## 색이 의미를 나른다
 *
 * 질문 획은 **빨강**이다. 프롬프트가 "빨간 표시"라고 지칭할 수 있어야 카드
 * 테두리·본문과 섞이지 않는다. OCR 그림(`renderInkPng`)은 지금처럼 검정이다 —
 * VARCO가 기대하는 형태이고, D176의 "화면과 전송본은 같은 획" 원칙은 그쪽에
 * 그대로 남는다. 여기는 색이 정보인 별개의 도식이다.
 *
 * ## 글자는 손글씨 폰트로 쓰지 않는다
 *
 * 캔버스의 글은 김주임 손글씨지만(D164), 이 그림의 독자는 학생이 아니라
 * 모델이다. 읽히는 것이 전부라 평범한 고딕으로 그린다.
 *
 * ## 기하는 여기 없다
 *
 * 상자와 좌표는 `inkScene`·`figureCrop`이 정한다. 이 파일은 그린다. 그 경계가
 * 흐려지면 "틀려도 그럴싸한 그림"을 테스트로 못 잡게 된다.
 */

import { containRect, worldToFigure } from "./figureCrop";
import type { InkScene, PickedCard } from "./inkScene";
import { drawStrokes, exportScale, type PenStroke } from "./penPad";
import type { Rect } from "./rect";

/** 질문 표시 색. 프롬프트의 "빨간 표시"가 이것이다. */
export const MARK_COLOR = "#e03131";

const CARD_BORDER = "#adb5bd";
const CARD_FILL = "#ffffff";
const BADGE_FILL = "#343a40";
const TITLE_COLOR = "#212529";
const BODY_COLOR = "#495057";

const BODY_FONT = "13px system-ui, -apple-system, 'Segoe UI', sans-serif";

const PAD = 10;
const LINE_H = 17;

/**
 * 번호 배지와 제목은 **그림 크기에 비례해 키운다.**
 *
 * 고정 크기(배지 반지름 11 · 제목 15px)로 그렸더니 모델이 번호를 못 읽었다 —
 * 실측 2026-08-05: 내용은 정확히 맞히면서("천문학에 관한 내용이다") 번호만
 * 틀렸다. 비전 인코더가 1280px 그림을 자기 해상도로 줄이면 22px 배지 안의
 * 13px 숫자가 뭉개진다. **읽을 수 없는 표시는 없는 표시와 같다.**
 *
 * 그래서 그림 높이의 몇 %로 잡는다. 캔버스는 배율 변환 안에서 그리므로
 * 월드 단위로 `capture.h × 비율`을 쓰면 배율이 상쇄돼 그림에서 늘 같은
 * 비중이 된다. 카드가 작을 때 배지가 카드를 삼키지 않게 상한도 둔다.
 */
const BADGE_MIN_R = 11;
const BADGE_RATIO = 0.030;
const TITLE_MIN = 15;
const TITLE_RATIO = 0.026;

function badgeRadius(captureH: number, cardH: number): number {
  return Math.max(BADGE_MIN_R, Math.min(captureH * BADGE_RATIO, cardH * 0.34));
}

function titlePx(captureH: number): number {
  return Math.max(TITLE_MIN, Math.round(captureH * TITLE_RATIO));
}

function roundedPath(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  ctx.beginPath();
  // roundRect는 최신 브라우저만 가진다 — 없으면 각진 상자로 떨어진다(정보는 같다).
  if (typeof ctx.roundRect === "function") ctx.roundRect(r.x, r.y, r.w, r.h, radius);
  else ctx.rect(r.x, r.y, r.w, r.h);
}

/**
 * 폭에 맞춰 줄을 나눈다.
 *
 * **글자 단위로 센다** — 한국어는 띄어쓰기가 드물어 단어 단위로 나누면 한 줄이
 * 상자를 통째로 넘긴다. `maxLines`를 넘으면 거기서 멈춘다(높이가 정해져 있다).
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (ch === "\n") {
      lines.push(cur);
      cur = "";
      if (lines.length >= maxLines) return lines;
      continue;
    }
    const next = cur + ch;
    if (ctx.measureText(next).width > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) return lines;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** 도판 그림이 실제로 놓인 자리. 카드 rect가 아니다 — 캡션이 아래에 붙는다. */
function imageBoxOf(card: PickedCard): Rect {
  return card.imageBox ?? card.rect;
}

/** 카드 하나 — 테두리 · 번호 배지 · 제목 · 본문(또는 도판 그림). */
function drawCard(
  ctx: CanvasRenderingContext2D,
  card: PickedCard,
  bitmap: ImageBitmap | undefined,
  captureH: number,
): void {
  const r = card.rect;
  const BADGE_R = badgeRadius(captureH, r.h);
  const titleFont = `700 ${titlePx(captureH)}px system-ui, -apple-system, sans-serif`;

  ctx.save();
  roundedPath(ctx, r, 8);
  ctx.fillStyle = CARD_FILL;
  ctx.fill();
  ctx.strokeStyle = CARD_BORDER;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 도판이면 그림을 제자리에 얹는다. 못 받았으면 라벨만 남는다 —
  // 도판 하나 때문에 질문 전체가 막히면 안 된다.
  if (bitmap) {
    const box = imageBoxOf(card);
    const fit = containRect(box, bitmap.width, bitmap.height);
    ctx.save();
    roundedPath(ctx, r, 8);
    ctx.clip();
    ctx.drawImage(bitmap, fit.x, fit.y, fit.w, fit.h);
    ctx.restore();
  }

  // 제목: 배지 오른쪽에서 시작한다.
  const textX = r.x + PAD + BADGE_R * 2 + 6;
  const textW = r.w - (textX - r.x) - PAD;
  let y = r.y + PAD + Math.max(13, titlePx(captureH) * 0.85);
  /**
   * **도판 위에는 글자를 얹지 않는다.** 이 그림의 독자는 그림을 읽어야 하는데
   * 제목이 그 위를 가로지르면 정작 봐야 할 도해를 덮는다 — "(제목 없음)"이
   * 다이어그램을 가로지르는 그림을 보내는 셈이 된다. 제목은 어차피 프롬프트에
   * **텍스트 명부로** 따로 가고, 그림에서 필요한 것은 번호(배지)뿐이다.
   */
  if (textW > 20 && !bitmap) {
    ctx.font = titleFont;
    ctx.fillStyle = TITLE_COLOR;
    ctx.textBaseline = "alphabetic";
    const title = wrapText(ctx, card.title ?? "(제목 없음)", textW, 1);
    for (const t of title) {
      ctx.fillText(t, textX, y);
      y += LINE_H;
    }
  }

  // 본문은 도판이 아닐 때만 — 그림 위에 글자를 얹으면 둘 다 못 읽는다.
  if (!bitmap && card.body) {
    const bodyW = r.w - PAD * 2;
    const room = Math.floor((r.y + r.h - PAD - y) / LINE_H);
    if (bodyW > 20 && room > 0) {
      ctx.font = BODY_FONT;
      ctx.fillStyle = BODY_COLOR;
      for (const ln of wrapText(ctx, card.body, bodyW, room)) {
        ctx.fillText(ln, r.x + PAD, y);
        y += LINE_H;
      }
    }
  }

  // 번호 배지는 **맨 위에** 그린다 — 도판을 덮어야 가려지지 않는다.
  // 이 번호가 VLM 출력의 [카드 N]이고, 우리 카드 id와의 유일한 연결이다.
  const bx = r.x + PAD + BADGE_R;
  const by = r.y + PAD + BADGE_R;
  ctx.beginPath();
  ctx.arc(bx, by, BADGE_R, 0, Math.PI * 2);
  ctx.fillStyle = BADGE_FILL;
  ctx.fill();
  ctx.font = `700 ${Math.round(BADGE_R * 1.25)}px system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(card.n), bx, by + 0.5);
  ctx.restore();
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

/**
 * 그림 1 — 전체 도식.
 *
 * `figures`는 도판 id → 비트맵. 없는 도판은 라벨 상자로 그려진다.
 */
export async function renderScenePng(
  scene: InkScene,
  figures: ReadonlyMap<string, ImageBitmap>,
  maxSide: number,
): Promise<Blob | null> {
  const box = scene.capture;
  if (!(box.w > 0) || !(box.h > 0)) return null;
  // 배율 규칙은 penPad와 같은 것을 쓴다 — 두 그림의 기하가 갈리지 않게.
  const scale = exportScale(box, 1, maxSide);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box.w * scale));
  canvas.height = Math.max(1, Math.round(box.h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);

  for (const card of scene.cards) {
    drawCard(
      ctx,
      card,
      card.figureId ? figures.get(card.figureId) : undefined,
      box.h,
    );
  }

  // 표시는 **맨 위에** — 카드에 가려지면 무엇을 가리키는지 볼 수 없다.
  // **표시만 그린다**(`scene.marks`) — 틀 잡기 점은 inkScene이 이미 뺐다.
  // 규칙을 두 곳에 두면 그림과 판정이 갈린다.
  drawStrokes(ctx, scene.marks, { color: MARK_COLOR });

  return toBlob(canvas);
}

/**
 * 그림 2 — 도판 확대본.
 *
 * 도판을 원본 해상도로 놓고 학생의 표시를 **도판 좌표계로 옮겨** 같은 자리에
 * 얹는다. 축척만 다른 같은 장면이라, 프롬프트가 "빨간 표시의 위치는 첫 번째
 * 그림과 같다"고 말할 수 있다.
 *
 * 그림 밖으로 나간 구간에서는 **획을 끊는다** — 가장자리로 뭉개면 원본에
 * 없는 획이 생긴다.
 *
 * `strokes`는 도식과 **같은 것**(`scene.marks`)이어야 한다. 전체 획을 넘기면
 * 도식에서는 뺀 틀 잡기 점이 확대본에만 찍히고, 그러면 프롬프트가 두 그림에
 * 대해 "표시의 위치는 같다"고 말하는 것이 거짓이 된다.
 */
export async function renderFigurePng(
  card: PickedCard,
  bitmap: ImageBitmap,
  strokes: readonly PenStroke[],
  maxSide: number,
): Promise<Blob | null> {
  const nw = bitmap.width;
  const nh = bitmap.height;
  if (!(nw > 0) || !(nh > 0)) return null;
  const scale = Math.min(1, maxSide / Math.max(nw, nh));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(nw * scale));
  canvas.height = Math.max(1, Math.round(nh * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const box = imageBoxOf(card);
  const mapped: PenStroke[] = [];
  for (const stroke of strokes) {
    let run: PenStroke = [];
    for (const pt of stroke) {
      const f = worldToFigure(pt.x, pt.y, box, nw, nh);
      if (f) {
        run.push({ x: f.x, y: f.y, p: pt.p });
      } else if (run.length) {
        mapped.push(run);
        run = [];
      }
    }
    if (run.length) mapped.push(run);
  }
  if (mapped.length) {
    // 원본 해상도에서는 화면 굵기가 가늘어 보인다 — 도판 크기에 비례해 키운다.
    const base = Math.max(2.8, Math.max(nw, nh) / 260);
    drawStrokes(ctx, mapped, { color: MARK_COLOR, base });
  }

  return toBlob(canvas);
}
