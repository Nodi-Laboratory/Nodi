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
import { EXPORT_PAD, strokeLength, type PenStroke } from "./penPad";
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

/**
 * 이 카드가 표시를 **어떻게** 받았나 — 기하로 계산한다.
 *
 * ## 왜 모델에게 안 묻나
 *
 * 처음에는 이것도 VLM에게 물었다. 그런데 **우리가 정확히 셀 수 있는 것**이다:
 * 획의 끝점이 카드 안에 있으면 그 카드를 짚은 것이고, 스쳐 지나가기만 했으면
 * 끝점이 딴 데 있다. 모델은 이 구분을 자주 틀렸고(실측 2026-08-05: 불확실할
 * 때 늘 1번을 답했다), 틀린 답이 그대로 SOLAR에 흘러갔다.
 *
 * **모델에게는 모델만 할 수 있는 일을 남긴다** — 그 표시가 무슨 뜻인지 한국어
 * 문장으로 쓰는 것. 어느 카드인지는 우리가 안다.
 */
export type MarkKind =
  /** 획이 카드를 **감쌌다**(동그라미). */
  | "circled"
  /** 획의 **끝**이 카드 안에서 멈췄다(화살표 끝·밑줄·톡 찍기). */
  | "pointed"
  /** 획이 카드 위를 **스쳐 지나가기만** 했다 — 짚은 것이 아니다. */
  | "crossed"
  /** 닿지 않았다. 근처에 있을 뿐. */
  | "near";

/** 짚은 것으로 볼 종류. `crossed`는 아니다 — 화살표 몸통이 지나간 것뿐이다. */
export const POINTING_KINDS: readonly MarkKind[] = ["circled", "pointed"];

export interface PickedCard extends SceneCard {
  /** 1부터. 읽는 순서. VLM 출력의 `[카드 N]`이 이 번호다. */
  n: number;
  /** 획이 실제로 닿았나(1단). false면 근처에 있을 뿐(2단). */
  touched: boolean;
  /** 어떻게 닿았나 — 짚은 것과 스쳐 간 것을 가른다. */
  mark: MarkKind;
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
  /**
   * 실제 **표시**만 남긴 획들 — 그림에 그릴 것도 이것뿐이다.
   *
   * 학생은 멀리 있는 카드까지 고려 대상에 넣으려고 **양 끝에 점을 톡 찍는다**.
   * 그 점은 "여기까지 봐 줘"라는 뜻이지 무언가를 가리키는 표시가 아니다.
   * 그래서 **고를 때는 세고 그릴 때는 뺀다** — 점까지 그리면 (a) 모델이 그것도
   * 표시로 보고 가장 가까운 카드에 붙이고 (b) 상자가 빈 하늘까지 늘어나
   * 정작 카드가 구석의 작은 조각이 된다(실측 2026-08-05, 둘 다).
   */
  marks: PenStroke[];
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

/**
 * 이 획들이 카드를 **어떻게** 건드렸나.
 *
 * 판정 순서가 곧 세기 순서다: 감쌌으면 감싼 것, 끝이 안에서 멈췄으면 짚은 것,
 * 그 밖에 닿았으면 스쳐 간 것이다.
 */
function markOf(
  strokes: readonly PenStroke[],
  card: Rect,
  hit: Rect,
  tipReach: number,
): MarkKind {
  let crossed = false;
  let pointed = false;
  for (const s of strokes) {
    const a = s[0];
    const z = s[s.length - 1];
    if (!a || !z) continue;

    // 1) 감쌈이 가장 센 신호다 — **먼저 본다.** 끝점 규칙을 먼저 태우면
    //    동그라미는 시작과 끝이 맞닿아 있어서 옆 카드까지 "짚음"이 된다
    //    (실측 2026-08-05: 카드 1을 감쌌는데 카드 2도 짚음으로 나왔다).
    const bb = strokesBBox([s]);
    if (bb) {
      const r = {
        x: bb.minX,
        y: bb.minY,
        w: bb.maxX - bb.minX,
        h: bb.maxY - bb.minY,
      };
      if (rectOverlap(r, card) >= card.w * card.h * 0.7) return "circled";
    }

    /**
     * 2) 짚음: 획의 **끝**이 이 카드 코앞에서 멈췄다(화살촉·밑줄·톡 찍기).
     *
     * "카드 **안**에서 멈췄나"로만 보면 화살표를 놓친다 — 학생은 화살촉을
     * 카드에 닿기 직전에 멈춘다(실측: 카드 아래 26px에서 끝나 모두 '근처'로
     * 떨어졌다). 사람이 보면 명백히 그 카드를 가리킨 것이다.
     *
     * **닫힌 획(동그라미)은 이 규칙에서 뺀다.** 시작과 끝이 같은 자리라
     * 방향을 뜻하지 않는다 — 감싸지 못한 큰 원이 옆 카드를 짚은 것으로
     * 둔갑한다.
     */
    const span = Math.hypot(z.x - a.x, z.y - a.y);
    const closed = span < strokeLength(s) * 0.2;
    if (!closed) {
      for (const end of [a, z]) {
        if (
          inside(end.x, end.y, hit) ||
          rectGap({ x: end.x, y: end.y, w: 0, h: 0 }, hit) <= tipReach
        ) {
          pointed = true;
        }
      }
    }

    if (strokeHitsRect(s, hit)) crossed = true;
  }
  if (pointed) return "pointed";
  return crossed ? "crossed" : "near";
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

  /**
   * 표시로 볼 획만 고른다 — 그림 대비 무시할 만큼 짧으면 **점**이다.
   *
   * 학생은 멀리 있는 카드까지 고려 대상에 넣으려고 양 끝에 점을 톡 찍는다.
   * 그건 "여기까지 봐 줘"지 무언가를 가리키는 표시가 아니다. **고를 때는
   * 세고**(위에서 이미 썼다) **그릴 때와 판정할 때는 뺀다.**
   *
   * 고정 길이로는 안 된다 — 같은 15px가 좁은 그림에서는 뚜렷한 표시이고 넓은
   * 그림에서는 티끌이다(실측 2026-08-05). 카드 위에 찍은 점은 남긴다("이거").
   */
  const dotMax = Math.max(12, Math.hypot(inkBox.w, inkBox.h) * 0.01);
  const marks = strokes.filter((s) => {
    if (strokeLength(s) >= dotMax) return true;
    const p = s[0];
    return !!p && cards.some((c) => inside(p.x, p.y, c.rect));
  });

  /**
   * 화살촉이 카드에 **닿기 직전**에 멈춰도 그 카드를 가리킨 것으로 본다.
   *
   * 학생은 화살표를 카드에 박지 않는다 — 코앞에서 멈춘다. 그림 크기에 비례해
   * 잡는다(넓은 화면에서는 "코앞"도 그만큼 멀다).
   */
  const tipReach = Math.max(24, Math.hypot(inkBox.w, inkBox.h) * 0.04);

  const picked: PickedCard[] = kept.map((s, i) => ({
    ...s.card,
    n: i + 1,
    touched: s.touched,
    mark: markOf(marks, s.card.rect, hitBox(s.card.rect), tipReach),
    where: whereOf.get(s.card.id) ?? "",
  }));

  /**
   * 그릴 상자는 **표시**와 카드만 감싼다 — 틀 잡기 점까지 감싸면 그림의
   * 대부분이 빈 하늘이 되고, 모델이 볼 것은 구석에 몰린다.
   */
  const markBox = strokesBBox(marks);
  const drawInk = markBox
    ? inflate(
        { x: markBox.minX, y: markBox.minY, w: markBox.maxX - markBox.minX, h: markBox.maxY - markBox.minY },
        EXPORT_PAD,
      )
    : inkBox;
  /**
   * **내용은 좁게, 허용치는 넓게.**
   *
   * 감쌀 것은 표시와 카드뿐이다(빈 하늘은 뺀다). 하지만 얼마나 커져도 되는지는
   * 학생이 찍은 점까지 포함한 `inkBox`가 정한다 — 점은 "여기까지 봐 줘"라는
   * 허용치이기 때문이다. 좁은 쪽으로 클램프하면 정작 카드가 잘린다(실측
   * 2026-08-05: 카드 셋 중 둘이 화면 밖으로 밀렸다).
   */
  const merged = union([drawInk, ...picked.map((c) => c.rect)]) ?? drawInk;
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
    marks,
    capture,
    cards: picked,
    dropped,
    clamped: capture.w < merged.w - 0.01 || capture.h < merged.h - 0.01,
    trace,
  };
}
