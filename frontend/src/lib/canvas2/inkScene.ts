/**
 * 질문 획 주변의 카드를 고르고, 그릴 상자를 정한다 (D178).
 *
 * ## 무엇을 푸는가
 *
 * D176은 손글씨를 글자로 바꿨다. 그런데 학생이 실제로 하는 일은 그것만이
 * 아니다 — **카드를 동그라미 치고, 화살표를 긋고, 그 끝에 질문을 쓴다.**
 * "이거에 대해서 더 자세하게 설명해줘"만 보내면 **"이거"가 사라진다.**
 * 이 파일은 그 "이거"의 후보를 고른다.
 *
 * ## 왜 순수 함수인가
 *
 * 기하는 눈으로 검증할 수 없다 — 틀려도 그럴싸한 그림이 나온다. `penPad`·
 * `connector`가 같은 이유로 lib에 있다. 렌더(`inkRender`)는 이 파일이 정한
 * 상자에 그리기만 하고, 이 파일은 캔버스를 모른다.
 *
 * ## 선정은 한 번뿐이다
 *
 * "주변에 카드가 있으면 포함되게 상자를 넓힌다"를 그대로 구현하면 **폭주한다**:
 * 상자를 키우면 새 카드가 들어오고, 그걸 포함하려 또 키우고, 조밀한
 * 캔버스에서는 결국 전체를 삼킨다.
 *
 * **선정은 원래 획 bbox 기준으로 딱 한 번 한다.** 그래서 종료가 수렴의 결과가
 * 아니라 알고리즘의 성질이다 — D123이 배치에서 택한 것과 같은 태도다.
 */

import { strokesBBox } from "./askInk";
import { EXPORT_PAD, type PenStroke } from "./penPad";
import { inflate, union, type Rect } from "./rect";
import type { ItemKind } from "./types";

/**
 * 도식에 그릴 후보 카드.
 *
 * `rect`는 **학생이 화면에서 보는 그대로의 상자**다. 접촉 판정에 쓰는 여백
 * (hover 박스, D126)은 이 값에 얹지 않고 `HIT_PAD_X/Y`로 **판정할 때만**
 * 부풀린다.
 *
 * 왜 나누나: `rect`는 그림에도 쓰인다. 여백을 얹은 채로 그리면 도식의 상자가
 * 실제 카드보다 사방으로 커져서, **닿지 않은 획이 닿은 것처럼 보인다.**
 * 그 그림으로 판정하는 것이 VLM이므로 그 차이가 그대로 답이 된다.
 */
export interface SceneCard {
  id: string;
  kind: ItemKind;
  title: string | null;
  body: string;
  rect: Rect;
  /** 도판일 때만. 원본 확대본을 받아 올 열쇠다. */
  figureId?: string;
  /**
   * 도판일 때, `<img>`가 실제로 놓인 월드 rect. 없으면 `rect`로 친다.
   *
   * **카드 rect와 다르다** — 도판 카드는 그림 아래에 캡션·쪽수가 붙어서
   * 그림이 카드의 위쪽 일부만 차지한다. 카드 전체에 그림을 그리면 학생이
   * 그린 동그라미가 그림 기준으로 위아래로 밀린다. 호출부가 DOM에서 재서
   * 넣는다(레이아웃 규칙을 두 곳에서 계산하지 않는다).
   */
  imageBox?: Rect;
}

export interface PickedCard extends SceneCard {
  /** 1부터. 읽는 순서. VLM 출력의 `[카드 N]`이 이 번호다. */
  n: number;
  /** 획이 실제로 닿았나(1단). false면 근처에 있을 뿐(2단). */
  touched: boolean;
  /**
   * 그림 안에서 이 카드가 있는 자리 — "맨 윗줄 왼쪽" 같은 말.
   *
   * **번호만으로는 모자란다.** 모델이 상자와 번호를 잇는 단서가 배지 숫자뿐인데
   * 비전 인코더가 그림을 줄이면 그 숫자가 뭉개진다(실측 2026-08-05: 내용은
   * 맞히면서 번호만 틀렸다). 자리는 줄어들어도 남는 단서라, 명부에 함께 준다.
   */
  where: string;
}

/**
 * 접촉 판정에만 얹는 여백 — hover 박스와 같은 크기(`connector.ts`의 `padded`).
 *
 * 학생이 화면에서 보는 경계와 판정이 같아야 "닿았는데 안 잡혔다"가 안 생긴다.
 * **그림에는 안 얹는다**(SceneCard.rect 주석 참조).
 */
export const HIT_PAD_X = 16;
export const HIT_PAD_Y = 12;

/** 판정용으로 부풀린 상자. */
function hitBox(r: Rect): Rect {
  return {
    x: r.x - HIT_PAD_X,
    y: r.y - HIT_PAD_Y,
    w: r.w + HIT_PAD_X * 2,
    h: r.h + HIT_PAD_Y * 2,
  };
}

export interface InkSceneOpts {
  cardMax: number;
  nearPad: number;
  boxMaxScale: number;
}

/** 카드 하나가 왜 뽑혔는지 · 왜 안 뽑혔는지. */
export type InkVerdict = "touched" | "near" | "over_cap" | "too_far";

/**
 * 후보 한 장의 판정 기록.
 *
 * **왜 남기나**: 이 알고리즘의 결과는 화면에 안 보인다. "왜 저 카드는 안
 * 들어갔지"를 나중에 물으면 답할 근거가 어디에도 없다 — 개념 연결(D172)이
 * 판정 로그를 붙인 것과 같은 이유다. 관리자 실험실이 이걸 그대로 표로 낸다.
 */
export interface InkTraceRow {
  id: string;
  title: string | null;
  kind: ItemKind;
  verdict: InkVerdict;
  /** 획 상자와의 최단 거리(월드 px). 접촉이면 0. */
  gap: number;
  /** 뽑혔으면 그 번호. 아니면 null. */
  n: number | null;
}

export interface InkScene {
  /** 획 bbox + 여백. 선정과 클램프의 **유일한** 기준이다. */
  inkBox: Rect;
  /** 실제로 그릴 상자. inkBox를 온전히 품는다. */
  capture: Rect;
  cards: PickedCard[];
  /** 상한 때문에 버린 카드 수. **조용히 자르지 않는다** — 0이 아니면 알린다. */
  dropped: number;
  /** 상자가 클램프에 걸려 잘렸나. */
  clamped: boolean;
  /** 후보 **전부**의 판정. 뽑힌 것만이 아니라 기각된 것도 남는다. */
  trace: InkTraceRow[];
}

/** 점이 사각형 안에 있나(변 포함). */
function inside(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 두 선분이 만나나. */
function segCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  // 평행·공선은 잡지 않는다 — 변을 따라 스치는 것은 접촉이 아니다.
  if (d === 0) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * 선분이 사각형에 닿나 — 안에서 끝나는 경우와 관통하는 경우 둘 다.
 *
 * **bbox로 재면 안 된다.** 대각선 화살표의 bbox는 커다란 직사각형이라,
 * 화살표가 지나가지도 않은 양쪽 구석의 카드가 접촉으로 잡힌다. 그러면 질문에
 * 엉뚱한 카드가 딸려 가고, SOLAR는 그것까지 설명한다.
 */
export function segmentHitsRect(
  ax: number, ay: number, bx: number, by: number, r: Rect,
): boolean {
  if (inside(ax, ay, r) || inside(bx, by, r)) return true;
  const x1 = r.x;
  const y1 = r.y;
  const x2 = r.x + r.w;
  const y2 = r.y + r.h;
  return (
    segCross(ax, ay, bx, by, x1, y1, x2, y1) ||
    segCross(ax, ay, bx, by, x2, y1, x2, y2) ||
    segCross(ax, ay, bx, by, x2, y2, x1, y2) ||
    segCross(ax, ay, bx, by, x1, y2, x1, y1)
  );
}

/** 획 하나가 사각형에 닿나. 점 하나짜리 획(톡 찍은 꼭지)도 센다. */
function strokeHitsRect(stroke: PenStroke, r: Rect): boolean {
  if (stroke.length === 0) return false;
  if (stroke.length === 1) return inside(stroke[0].x, stroke[0].y, r);
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1];
    const b = stroke[i];
    if (segmentHitsRect(a.x, a.y, b.x, b.y, r)) return true;
  }
  return false;
}

/**
 * 두 사각형이 겹치는 넓이. 안 겹치면 0.
 *
 * 도판이 둘 이상 표시에 닿았을 때 **어느 것을 확대해 보낼지** 고르는 잣대다
 * (하나만 보낸다 — 전부 보내면 비용이 선형으로 늘고, 화살표는 보통 하나를
 * 가리킨다).
 */
export function rectOverlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 두 사각형 사이 최단 거리. 겹치면 0. */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

/**
 * 상자를 기준 상자의 배율 안으로 자른다.
 *
 * **기준 상자(획)는 절대 잘리지 않는다** — 획이 잘리면 OCR이 본 질문과 VLM이
 * 본 질문이 갈린다. 그래서 획을 중심에 두고 자른다.
 */
function clampBox(box: Rect, base: Rect, scale: number): Rect {
  const maxW = Math.max(base.w, base.w * scale);
  const maxH = Math.max(base.h, base.h * scale);
  if (box.w <= maxW && box.h <= maxH) return box;
  const w = Math.min(box.w, maxW);
  const h = Math.min(box.h, maxH);
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function buildInkScene(
  strokes: readonly PenStroke[],
  cards: readonly SceneCard[],
  opts: InkSceneOpts,
): InkScene | null {
  const b = strokesBBox(strokes);
  if (!b) return null;
  const inkBox = inflate(
    { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY },
    EXPORT_PAD,
  );

  /**
   * 1단 접촉 · 2단 근접.
   *
   * **판정 기준은 언제나 inkBox다** — 뒤에서 상자를 키우더라도 그 결과를
   * 여기로 되먹이지 않는다. 그것이 폭주를 막는 유일한 장치다.
   */
  const scored = cards.map((c) => {
    // 판정에만 여백을 얹는다 — `c.rect`(그림에 쓰이는 값)는 안 건드린다.
    const hit = hitBox(c.rect);
    return {
      card: c,
      touched: strokes.some((s) => strokeHitsRect(s, hit)),
      gap: rectGap(inkBox, hit),
    };
  });

  const eligible = scored.filter((s) => s.touched || s.gap <= opts.nearPad);
  // 접촉 먼저, 그다음 가까운 순. 상한을 넘으면 뒤에서 잘린다.
  eligible.sort((a, x) =>
    a.touched !== x.touched ? (a.touched ? -1 : 1) : a.gap - x.gap,
  );
  const kept = eligible.slice(0, Math.max(0, opts.cardMax));
  const dropped = eligible.length - kept.length;

  /**
   * 번호는 **읽는 순서**로 매긴다 — VLM의 공간 추론과 번호가 어긋나면
   * "위에서 두 번째"와 `[카드 2]`가 다른 것을 가리킨다.
   *
   * 같은 줄 판정은 세로 겹침으로 본다(y가 딱 같을 일은 없다).
   */
  kept.sort((a, x) => {
    const ay = a.card.rect.y;
    const xy = x.card.rect.y;
    const sameRow = Math.abs(ay - xy) < Math.min(a.card.rect.h, x.card.rect.h) / 2;
    return sameRow ? a.card.rect.x - x.card.rect.x : ay - xy;
  });

  /**
   * 자리 이름을 붙인다 — **줄**은 세로로 겹치는 것끼리 묶고, 줄 안에서 가로
   * 순서를 센다. 그림에서 사람이 "맨 윗줄 가운데"라고 부르는 그 방식이다.
   */
  const rows: (typeof kept)[] = [];
  for (const s of kept) {
    const row = rows.find((r) =>
      r.some(
        (o) =>
          Math.abs(o.card.rect.y - s.card.rect.y) <
          Math.min(o.card.rect.h, s.card.rect.h) / 2,
      ),
    );
    if (row) row.push(s);
    else rows.push([s]);
  }
  const rowName = (i: number): string =>
    rows.length === 1 ? "" : i === 0 ? "맨 윗줄 " : i === rows.length - 1 ? "맨 아랫줄 " : `${i + 1}번째 줄 `;
  const colName = (i: number, n: number): string =>
    n === 1 ? "가운데" : i === 0 ? "왼쪽" : i === n - 1 ? "오른쪽" : "가운데";

  const whereOf = new Map<string, string>();
  rows.forEach((row, ri) => {
    row.forEach((s, ci) => {
      whereOf.set(s.card.id, (rowName(ri) + colName(ci, row.length)).trim());
    });
  });

  const picked: PickedCard[] = kept.map((s, i) => ({
    ...s.card,
    n: i + 1,
    touched: s.touched,
    where: whereOf.get(s.card.id) ?? "",
  }));

  const merged = union([inkBox, ...picked.map((c) => c.rect)]) ?? inkBox;
  const capture = clampBox(merged, inkBox, opts.boxMaxScale);

  // 후보 **전부**의 판정을 남긴다 — 기각된 것이 더 궁금할 때가 많다.
  const byId = new Map(picked.map((c) => [c.id, c]));
  const keptIds = new Set(kept.map((s) => s.card.id));
  const trace: InkTraceRow[] = scored.map((s) => {
    const got = byId.get(s.card.id);
    const eligible = s.touched || s.gap <= opts.nearPad;
    const verdict: InkVerdict = !eligible
      ? "too_far"
      : !keptIds.has(s.card.id)
        ? "over_cap"
        : s.touched
          ? "touched"
          : "near";
    return {
      id: s.card.id,
      title: s.card.title,
      kind: s.card.kind,
      verdict,
      gap: s.touched ? 0 : s.gap,
      n: got?.n ?? null,
    };
  });

  return {
    inkBox,
    capture,
    cards: picked,
    dropped,
    clamped: capture.w < merged.w - 0.01 || capture.h < merged.h - 0.01,
    trace,
  };
}
