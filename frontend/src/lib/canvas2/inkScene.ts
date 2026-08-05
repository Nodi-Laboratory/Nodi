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
 *
 * ## 모양은 여기서 읽지 않는다
 *
 * "무엇을 그렸나"는 `inkShapes`가 카드와 무관하게 한 번 읽는다. 이 파일은 그
 * 결과를 카드에 **잇기만** 한다. 예전에는 한 함수가 둘을 같이 해서 카드마다
 * 획의 성질을 다시 계산했다.
 */

import { EXPORT_PAD, type PenStroke } from "./penPad";
import {
  enclosureRatio,
  inside,
  measureStrokes,
  pointGap,
  readGestures,
  rectGap,
  rectOverlap,
  segmentHitsRect,
  strokeHitsRect,
  strokeSize,
  strokesTouch,
  type Gesture,
  type GestureShape,
  type StrokeInfo,
} from "./inkShapes";
import { contains, inflate, union, type Rect } from "./rect";
import type { ItemKind } from "./types";

// 기하 원시 함수는 `inkShapes`가 소유한다. 여기서 다시 내보내는 것은 예전부터
// 이 이름으로 쓰던 호출부(`inkCapture`·테스트)를 위해서다.
export { rectGap, rectOverlap, segmentHitsRect };

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
  /** 표시가 카드를 **감쌌다**(동그라미). */
  | "circled"
  /** 표시를 카드 **안에** 그렸다(한 구절 동그라미·밑줄·별표·덧칠). */
  | "within"
  /** 화살촉·선 끝이 이 카드에서 멈췄다 — **가리킨 것이다.** */
  | "pointed"
  /** 선이 이 카드에서 **출발해** 다른 데로 갔다. 대상이 아니라 출처다. */
  | "linked"
  /** 표시가 카드 위를 **스쳐 지나가기만** 했다 — 짚은 것이 아니다. */
  | "crossed"
  /** 닿지 않았다. 근처에 있을 뿐. */
  | "near";

/**
 * 짚은 것으로 볼 종류.
 *
 * `linked`는 **뺀다** — 화살표가 카드 1에서 카드 3으로 갔다면 학생이 묻는 것은
 * 카드 3이다. 둘 다 대상으로 치면 SOLAR가 둘 다 설명하고, 이어 묻기의 부모도
 * 엉뚱한 쪽에 붙는다. `crossed`도 뺀다 — 화살표 몸통이 지나간 것뿐이다.
 */
export const POINTING_KINDS: readonly MarkKind[] = ["circled", "within", "pointed"];

/** 센 정도. 카드 하나에 표시가 여럿 걸리면 가장 센 것을 남긴다. */
const MARK_RANK: Record<MarkKind, number> = {
  circled: 5,
  within: 4,
  pointed: 3,
  linked: 2,
  crossed: 1,
  near: 0,
};

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
 * 표시 하나가 어느 카드와 어떤 관계인가 — **프롬프트에 실을 사실.**
 *
 * 카드마다 낱말 하나(`mark`)만 주면 "화살표가 [카드 1]에서 [카드 3]으로
 * 향한다"를 말할 수 없다. 그 문장은 카드가 아니라 **표시**에 딸린 사실이다.
 * 학생이 그린 것이 몇 개고 각각 무엇을 했는지가 여기서 온다.
 */
export interface SceneGesture {
  /** 1부터. "첫 번째 표시"로 부를 때 쓴다. */
  i: number;
  shape: GestureShape;
  /** 감싼 카드 번호. */
  encloses: number[];
  /** 이 카드 **안에** 그린 표시(한 구절 밑줄·별표). */
  within: number[];
  /** 끝이 가리킨 카드 번호. */
  points: number[];
  /** 출발점이 놓인 카드 번호. */
  from: number[];
  /** 스쳐 지나간 카드 번호. */
  crosses: number[];
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
   * 그림에 그릴 획들 — 틀 잡기 점만 뺀 나머지다.
   *
   * 학생은 멀리 있는 카드까지 고려 대상에 넣으려고 **양 끝에 점을 톡 찍는다**.
   * 그 점은 "여기까지 봐 줘"라는 뜻이지 무언가를 가리키는 표시가 아니다.
   * 그래서 **고를 때는 세고 그릴 때는 뺀다** — 점까지 그리면 (a) 모델이 그것도
   * 표시로 보고 가장 가까운 카드에 붙이고 (b) 상자가 빈 하늘까지 늘어나
   * 정작 카드가 구석의 작은 조각이 된다(실측 2026-08-05, 둘 다).
   *
   * **질문 글씨는 여기 남는다.** 모델이 학생이 뭘 물었는지도 봐야 한다 —
   * 다만 글씨는 아래 `gestures`에서 빠진다(가리키는 표시가 아니다).
   */
  marks: PenStroke[];
  /** 실제로 그릴 상자. inkBox를 온전히 품는다. */
  capture: Rect;
  cards: PickedCard[];
  /** 학생이 그린 표시들과 그것이 카드와 맺은 관계. */
  gestures: SceneGesture[];
  /** 상한 때문에 버린 카드 수. **조용히 자르지 않는다** — 0이 아니면 알린다. */
  dropped: number;
  /** 상자가 클램프에 걸려 잘렸나. */
  clamped: boolean;
  /** 후보 **전부**의 판정. 뽑힌 것만이 아니라 기각된 것도 남는다. */
  trace: InkTraceRow[];
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

/** 그림 대비 이보다 짧으면 **점**이다 — 틀 잡기용이지 표시가 아니다. */
const DOT_RATIO = 0.01;
const DOT_MIN = 12;
/**
 * 그림 대비 이보다 짧으면 **글씨**로 본다 — 가리키는 표시가 아니다.
 *
 * 학생이 쓴 질문 글씨도 획이다. 그걸 표시로 세면 카드 옆에 질문을 쓴 것만으로
 * 글자 획의 끝점이 그 카드를 "짚은" 것이 된다 — 화살표를 긋지 않았는데도.
 * 한글 한 글자는 획 대여섯이고 하나하나가 짧다. 가리키는 표시(동그라미·화살표)는
 * 카드에 가 닿아야 하므로 언제나 그림에서 큰 축을 차지한다.
 *
 * ⚠️ 글씨를 아주 크게 쓰면 이 잣대만으로는 못 가른다. 그래서 `crowded`가
 * 두 번째 그물이다 — 글씨는 **비슷한 크기의 이웃이 많다.**
 */
const MARK_RATIO = 0.12;
/** 획을 한 표시로 묶을 거리(그림 대각선 대비). */
const JOIN_RATIO = 0.015;
const JOIN_MIN = 14;
/**
 * 화살촉이 카드에 **닿기 직전**에 멈춰도 그 카드를 가리킨 것으로 본다.
 *
 * 학생은 화살표를 카드에 박지 않는다 — 코앞에서 멈춘다(실측: 카드 아래
 * 26px에서 끝났다). 그림 크기에 비례해 잡는다.
 */
const TIP_RATIO = 0.04;
const TIP_MIN = 24;
/** 카드의 이 비율 이상이 고리 안에 들면 **감쌌다**고 본다. */
const ENCLOSE_MIN = 0.5;
/** 카드 안에 그린 표시로 볼 최소 크기(카드 대각선 대비). */
const WITHIN_RATIO = 0.18;

/**
 * 이 획이 **글씨 뭉치의 일부**인가 — 비슷한 크기의 이웃이 셋 이상인가.
 *
 * 글씨는 같은 크기의 획이 다닥다닥 붙어 줄을 이룬다. 동그라미·화살표는 그렇지
 * 않다 — 크기가 비슷한 이웃이 곁에 없다. 크기 잣대(`MARK_RATIO`)만으로는 글씨를
 * 크게 쓴 학생을 못 거르므로 이 그물을 하나 더 친다.
 */
function crowded(s: StrokeInfo, all: readonly StrokeInfo[]): boolean {
  const size = strokeSize(s);
  if (size <= 0) return false;
  let n = 0;
  for (const o of all) {
    if (o === s) continue;
    const os = strokeSize(o);
    // 크기가 2배 넘게 차이 나면 이웃이 아니라 배경이다(화살촉·글씨 옆의 동그라미).
    if (os < size * 0.5 || os > size * 2) continue;
    if (rectGap(s.box, o.box) > size * 1.5) continue;
    if (++n >= 3) return true;
  }
  return false;
}

/** 표시 하나와 카드 하나의 관계. 센 것부터 본다. */
function relate(g: Gesture, card: Rect, hit: Rect, tipReach: number): MarkKind {
  // 1) 감쌈이 가장 센 신호다 — **먼저 본다.** 끝점 규칙을 먼저 태우면
  //    동그라미는 시작과 끝이 맞닿아 있어서 옆 카드까지 "짚음"이 된다
  //    (실측 2026-08-05: 카드 1을 감쌌는데 카드 2도 짚음으로 나왔다).
  if (g.closed && enclosureRatio(g.poly, card) >= ENCLOSE_MIN) return "circled";

  // 2) 표시가 카드 안에 온전히 들어 있다 — 본문 한 구절에 밑줄·동그라미를
  //    쳤거나 카드 위를 덧칠한 것이다. 그 카드를 짚은 것이 맞다.
  if (contains(hit, g.box)) return "within";

  // 3) 끝이 코앞에서 멈췄다 = 가리켰다. 출발점(4)보다 세다 — 화살표가
  //    카드 1에서 카드 3으로 갔다면 학생이 묻는 것은 카드 3이다.
  if (g.tip && pointGap(g.tip, hit) <= tipReach) return "pointed";
  if (g.tail && pointGap(g.tail, hit) <= tipReach) return "linked";

  if (g.strokes.some((s) => strokeHitsRect(s, hit))) return "crossed";
  return "near";
}

export function buildInkScene(
  strokes: readonly PenStroke[],
  cards: readonly SceneCard[],
  opts: InkSceneOpts,
): InkScene | null {
  // **획은 한 번만 잰다.** 아래 전부가 이 값을 쓴다 — 카드마다 다시 재면
  // 카드 수만큼 곱해진다.
  const infos = measureStrokes(strokes);
  const raw = union(infos.map((s) => s.box));
  if (!raw) return null;
  const inkBox = inflate(raw, EXPORT_PAD);
  const diag = Math.hypot(inkBox.w, inkBox.h);

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
      hit,
      touched: infos.some((s) => strokeHitsRect(s, hit)),
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
   * 획을 셋으로 가른다 — **점 / 글씨 / 표시.**
   *
   *   · 점   그리지도 판정하지도 않는다. 다만 상자가 커질 허용치는 정한다.
   *   · 글씨 그리기는 한다(모델이 질문도 봐야 한다). 판정에서는 뺀다.
   *   · 표시 그리고 판정한다.
   *
   * 고정 길이로는 안 된다 — 같은 15px가 좁은 그림에서는 뚜렷한 표시이고 넓은
   * 그림에서는 티끌이다(실측 2026-08-05). 카드 위에 찍은 점은 남긴다("이거").
   */
  const dotMax = Math.max(DOT_MIN, diag * DOT_RATIO);
  const drawn = infos.filter((s) => {
    if (s.len >= dotMax) return true;
    const p = s.pts[0];
    return !!p && cards.some((c) => inside(p.x, p.y, c.rect));
  });

  const markMin = Math.max(dotMax * 3, diag * MARK_RATIO);
  const joinGap = Math.max(JOIN_MIN, diag * JOIN_RATIO);

  /**
   * 표시의 **몸통**이 될 획들. 글씨는 여기서 걸러진다.
   *
   * 짧아도 **카드 안에 온전히 그린 것**은 몸통이다 — 한 구절 밑줄·별표·체크.
   * 카드 크기에 비례해 잡는다(글자 획은 이 잣대를 못 넘는다).
   */
  const seeds = drawn.filter((s) => {
    if (crowded(s, drawn)) return false;
    if (s.len >= markMin) return true;
    return kept.some((k) => {
      const d = Math.hypot(k.card.rect.w, k.card.rect.h);
      return contains(k.hit, s.box) && strokeSize(s) >= d * WITHIN_RATIO;
    });
  });

  /**
   * 몸통에 **붙은** 짧은 획은 표시의 일부다 — 대개 화살촉이다.
   *
   * 크기만으로 자르면 이게 통째로 사라진다. 화살촉은 짧고(몸통의 10분의 1쯤)
   * 글씨와 크기가 비슷하다. 가르는 것은 크기가 아니라 **어디에 붙었나**다:
   * 촉은 몸통 끝에 붙어 있고 글씨는 아무 데도 안 붙어 있다. `crowded`가 이미
   * 글씨 줄을 걸렀으므로, 남은 짧은 획 중 몸통에 닿은 것만 주우면 된다.
   */
  const seedSet = new Set(seeds);
  const marked = drawn.filter((s) => {
    if (seedSet.has(s)) return true;
    if (crowded(s, drawn)) return false;
    return seeds.some((b) => strokesTouch(s, b, joinGap));
  });

  const tipReach = Math.max(TIP_MIN, diag * TIP_RATIO);
  const shapes = readGestures(marked, { joinGap });

  /**
   * 표시 × 카드 관계를 **한 번** 계산하고 양쪽에서 읽는다 — 카드는 가장 센
   * 관계를 자기 `mark`로, 표시는 카드 번호 목록을 자기 사실로 가져간다.
   */
  const picked: PickedCard[] = kept.map((s, i) => ({
    ...s.card,
    n: i + 1,
    touched: s.touched,
    mark: "near" as MarkKind,
    where: whereOf.get(s.card.id) ?? "",
  }));

  const gestures: SceneGesture[] = shapes.map((g, gi) => {
    const row: SceneGesture = {
      i: gi + 1,
      shape: g.shape,
      encloses: [],
      within: [],
      points: [],
      from: [],
      crosses: [],
    };
    kept.forEach((s, ci) => {
      const kind = relate(g, s.card.rect, s.hit, tipReach);
      if (MARK_RANK[kind] > MARK_RANK[picked[ci].mark]) picked[ci].mark = kind;
      const n = picked[ci].n;
      if (kind === "circled") row.encloses.push(n);
      else if (kind === "within") row.within.push(n);
      else if (kind === "pointed") row.points.push(n);
      else if (kind === "linked") row.from.push(n);
      else if (kind === "crossed") row.crosses.push(n);
    });
    return row;
  });

  /**
   * 그릴 상자는 **그릴 획**과 카드만 감싼다 — 틀 잡기 점까지 감싸면 그림의
   * 대부분이 빈 하늘이 되고, 모델이 볼 것은 구석에 몰린다.
   */
  const drawnBox = union(drawn.map((s) => s.box));
  const drawInk = drawnBox ? inflate(drawnBox, EXPORT_PAD) : inkBox;
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
    const ok = s.touched || s.gap <= opts.nearPad;
    const verdict: InkVerdict = !ok
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
    marks: drawn.map((s) => s.pts),
    capture,
    cards: picked,
    gestures,
    dropped,
    clamped: capture.w < merged.w - 0.01 || capture.h < merged.h - 0.01,
    trace,
  };
}
