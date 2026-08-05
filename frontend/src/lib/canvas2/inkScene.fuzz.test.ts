/**
 * 표시 읽기 — **무작위 장면 대량 검증** (D178).
 *
 * ## 왜 필요한가
 *
 * 손으로 고른 예제는 내가 이미 이해한 경우만 덮는다. 실제로 이 기능이 틀린
 * 방식은 전부 **내가 상상하지 못한 조합**에서 나왔다 — 화살표 둘이 꼬리를
 * 공유한 것, 카드에서 질문으로 그은 것, 60px 못 미쳐 멈춘 것. 셋 다 사용자가
 * 먼저 찾았다.
 *
 * 그래서 장면을 흔들어 가며 만든다: 카드 수·크기·간격, 표시 종류, 그린 방향,
 * 멈춘 거리, 손떨림, 질문 글씨 자리. 정답은 **생성할 때 안다**(어느 카드를
 * 겨냥해 그렸는지) — 그것과 기하의 답을 맞춰 본다.
 *
 * ## 무작위인데 재현된다
 *
 * 씨앗 고정 LCG를 쓴다. 깨지면 같은 장면이 다시 나온다 — 안 그러면 "가끔
 * 실패하는 테스트"가 되어 아무도 안 고친다. 배치 엔진의 무겹침 검사(200 케이스)와
 * 같은 태도다.
 */

import { describe, expect, it } from "vitest";
import {
  buildInkScene,
  rectGap,
  POINTING_KINDS,
  segmentHitsRect,
  type SceneCard,
} from "./inkScene";
import { handwriting, hookArrow, oval, path, pieceArrow } from "./inkStrokes.fixture";
import type { PenStroke } from "./penPad";

const OPTS = { cardMax: 8, nearPad: 500, boxMaxScale: 3 };

/** 씨앗 고정 난수 — 깨진 장면을 그대로 되살릴 수 있어야 한다. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 손떨림 — 사람이 그은 선은 곧지 않다. 곧은 선만으로 재면 규칙이 헐거워진다. */
function wobble(s: PenStroke, r: () => number, amp: number): PenStroke {
  return s.map((p) => ({
    x: p.x + (r() - 0.5) * amp,
    y: p.y + (r() - 0.5) * amp,
    p: p.p,
  }));
}

interface Scene {
  cards: SceneCard[];
  strokes: PenStroke[];
  /** 정답 — 이 카드를 겨냥해 그렸다. */
  want: string;
  how: string;
}

const HOWS = [
  "감쌈",
  "화살표(질문→카드)",
  "화살표(카드→질문)",
  "화살표(못 미침)",
  "촉 없는 선",
  "몸통·촉 따로",
  "카드 안 밑줄",
] as const;

/**
 * 장면 하나를 만든다.
 *
 * 카드는 격자에 놓되 크기·간격을 흔든다. 질문 글씨는 카드가 없는 아래쪽에
 * 쓴다 — 학생이 실제로 그러기 때문이고, 그 자리가 방향의 기준점이 된다.
 */
function makeScene(seed: number): Scene {
  const r = rng(seed);
  const cols = 2 + Math.floor(r() * 3); // 2~4
  const rows = 1 + Math.floor(r() * 2); // 1~2
  const w = 360 + Math.floor(r() * 260);
  const h = 100 + Math.floor(r() * 90);
  const gapX = w + 80 + Math.floor(r() * 200);
  const gapY = h + 120 + Math.floor(r() * 160);

  const cards: SceneCard[] = [];
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const id = `c${ry}-${cx}`;
      cards.push({
        id,
        kind: "concept",
        title: id,
        body: "본문",
        rect: { x: cx * gapX, y: ry * gapY, w, h },
      });
    }
  }

  const how = HOWS[Math.floor(r() * HOWS.length)];

  // 질문 글씨는 카드 격자 **아래**. 글자 크기도 흔든다.
  const textX = Math.floor(r() * (cols - 1) * gapX);
  const textY = rows * gapY + 60 + Math.floor(r() * 120);
  const text = handwriting(textX, textY, 5 + Math.floor(r() * 5), 28 + r() * 22);
  const from = { x: textX + 60, y: textY - 20 };

  /**
   * 목표는 **질문에서 곧장 보이는 카드**여야 한다.
   *
   * 다른 카드가 길목을 막고 있으면 정답이 하나로 정해지지 않는다 — 그 화살표는
   * 사람이 봐도 앞의 카드를 가리킨 것으로 읽힌다. 그런 장면으로 재면 알고리즘이
   * 아니라 문제 설정을 시험하게 된다.
   */
  const sideOf = (c: SceneCard) => ({
    x: c.rect.x + c.rect.w * (0.2 + r() * 0.6),
    y: c.rect.y + c.rect.h + 6,
  });
  const clear = cards.filter((c) => {
    const s = { x: c.rect.x + c.rect.w / 2, y: c.rect.y + c.rect.h + 6 };
    return !cards.some(
      (o) =>
        o !== c &&
        segmentHitsRect(from.x, from.y, s.x, s.y, {
          x: o.rect.x - 20,
          y: o.rect.y - 20,
          w: o.rect.w + 40,
          h: o.rect.h + 40,
        }),
    );
  });
  const pool = clear.length ? clear : cards;
  const want = pool[Math.floor(r() * pool.length)];
  const t = want.rect;

  // 카드 변 위의 한 점 — 화살표가 겨눌 자리.
  const side = sideOf(want);
  const amp = 2 + r() * 5;
  const marks: PenStroke[] = [];

  if (how === "감쌈") {
    marks.push(
      wobble(oval(t.x + t.w / 2, t.y + t.h / 2, t.w * 0.62, t.h * 0.85), r, amp),
    );
  } else if (how === "화살표(질문→카드)") {
    marks.push(wobble(hookArrow(from.x, from.y, side.x, side.y), r, amp));
  } else if (how === "화살표(카드→질문)") {
    marks.push(wobble(hookArrow(side.x, side.y, from.x, from.y), r, amp));
  } else if (how === "화살표(못 미침)") {
    // 카드 코앞이 아니라 **한참 앞**에서 멈춘다 — 사람이 실제로 그런다.
    const k = 0.35 + r() * 0.3;
    const stop = {
      x: from.x + (side.x - from.x) * k,
      y: from.y + (side.y - from.y) * k,
    };
    marks.push(wobble(hookArrow(from.x, from.y, stop.x, stop.y), r, amp));
  } else if (how === "촉 없는 선") {
    marks.push(wobble(path([from.x, from.y], [side.x, side.y]), r, amp));
  } else if (how === "몸통·촉 따로") {
    for (const s of pieceArrow(from.x, from.y, side.x, side.y)) {
      marks.push(wobble(s, r, amp));
    }
  } else {
    // 카드 안 한 구절에 밑줄.
    const y = t.y + t.h * (0.45 + r() * 0.35);
    marks.push(
      wobble(path([t.x + t.w * 0.12, y], [t.x + t.w * 0.7, y]), r, amp * 0.4),
    );
  }

  return { cards, strokes: [...text, ...marks], want: want.id, how };
}

/** 이 장면에서 기하가 짚었다고 본 카드들. */
function pointedIds(sc: Scene): string[] {
  const s = buildInkScene(sc.strokes, sc.cards, OPTS);
  if (!s) return [];
  return s.cards.filter((c) => POINTING_KINDS.includes(c.mark)).map((c) => c.id);
}

describe("표시 읽기 — 무작위 장면", () => {
  /**
   * **정확히 하나를 짚어야 한다.** 여럿을 짚으면 SOLAR가 묻지 않은 카드까지
   * 설명하고, 하나도 못 짚으면 프롬프트가 "아무것도 안 짚었다"고 말해 모델이
   * 지어낸다 — 둘 다 학생에게는 "AI가 못 알아본다"로 보인다.
   */
  it("900개 장면에서 겨냥한 카드를 정확히 짚는다", () => {
    const bad: string[] = [];
    const byHow = new Map<string, { ok: number; n: number }>();
    for (let seed = 1; seed <= 900; seed++) {
      const sc = makeScene(seed);
      const got = pointedIds(sc);
      const ok = got.length === 1 && got[0] === sc.want;
      const cur = byHow.get(sc.how) ?? { ok: 0, n: 0 };
      byHow.set(sc.how, { ok: cur.ok + (ok ? 1 : 0), n: cur.n + 1 });
      if (!ok) {
        const sn = buildInkScene(sc.strokes, sc.cards, OPTS)!;
        const tgt = sc.cards.find((c) => c.id === sc.want)!;
        bad.push(
          `seed ${seed} [${sc.how}] 정답 ${sc.want} → ${JSON.stringify(got)}` +
            ` | 표시 ${JSON.stringify(sn.gestures)} | 후보 ${sn.cards.map((c) => c.id)}` +
            ` | 획거리 ${Math.round(rectGap(sn.inkBox, tgt.rect))}`,
        );
      }
    }
    const table0 = [...byHow].map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(" · ");
    console.log(`[표시 읽기] ${table0}`);
    if (bad.length) {
      const table = [...byHow]
        .map(([k, v]) => `  ${k}: ${v.ok}/${v.n}`)
        .join("\n");
      throw new Error(
        `${bad.length}/900 실패\n${table}\n\n${bad.slice(0, 12).join("\n")}`,
      );
    }
    expect(bad).toHaveLength(0);
  });

  /**
   * **여러 카드를 한 번에 가리키는 경우** — "이거 두개 비교해줘".
   *
   * 사용자가 실제로 막힌 자리다(2026-08-05). 두 화살표의 꼬리가 같은 자리에서
   * 나오고, 예전에는 그 둘이 한 표시로 뭉쳐 짚은 카드가 0개가 됐다. 꼬리 간격을
   * 0부터 벌려 가며 흔든다 — 붙어 있을 때가 가장 어렵다.
   */
  it("두 카드를 겨눈 화살표 둘을 둘 다 짚는다", () => {
    const bad: string[] = [];
    for (let seed = 3000; seed < 3300; seed++) {
      const sc = makeScene(seed);
      const r = rng(seed);
      const cards = sc.cards;
      if (cards.length < 2) continue;
      const i = Math.floor(r() * cards.length);
      let j = Math.floor(r() * cards.length);
      if (j === i) j = (i + 1) % cards.length;
      const lo = cards.reduce((a, c) => Math.max(a, c.rect.y + c.rect.h), 0);
      const fx = cards[0].rect.x + 80;
      const fy = lo + 220 + r() * 160;
      const text = handwriting(fx - 40, fy + 40, 6, 30);
      // 꼬리 간격 0~90px — 0이면 완전히 같은 자리에서 갈라져 나간다.
      const spread = r() * 90;
      const aimAt = (c: SceneCard) => ({
        x: c.rect.x + c.rect.w * (0.3 + r() * 0.4),
        y: c.rect.y + c.rect.h + 8,
      });
      const a1 = aimAt(cards[i]);
      const a2 = aimAt(cards[j]);
      const strokes = [
        ...text,
        wobble(hookArrow(fx, fy, a1.x, a1.y), r, 3),
        wobble(hookArrow(fx + spread, fy, a2.x, a2.y), r, 3),
      ];
      const got = new Set(pointedIds({ ...sc, strokes }));
      const want = new Set([cards[i].id, cards[j].id]);
      const same =
        got.size === want.size && [...want].every((x) => got.has(x));
      if (!same) {
        bad.push(
          `seed ${seed} 간격 ${spread.toFixed(0)} 정답 ${[...want]} → ${[...got]}`,
        );
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * **아무것도 안 겨눈 화살표.**
   *
   * 겨눈 쪽으로 늘여 보는 규칙(`AIM_REACH`)이 헐거워지면 여기서 드러난다 —
   * 늘이는 거리를 키울수록 카드를 잘 잡지만, 너무 키우면 **허공을 겨눈
   * 화살표가 화면 반대편 카드를 짚었다고 우긴다.** 위의 300개와 이 검사가
   * 그 상수의 위아래를 함께 눌러 준다.
   */
  it("허공을 겨눈 화살표는 아무 카드도 짚지 않는다", () => {
    const bad: string[] = [];
    for (let seed = 2000; seed < 2300; seed++) {
      const sc = makeScene(seed);
      const r = rng(seed);
      // 카드는 전부 y >= 0에 있다. 글씨 아래에서 **더 아래로** 긋는다.
      const box = sc.cards.reduce(
        (a, c) => ({
          x: Math.min(a.x, c.rect.x),
          y: Math.max(a.y, c.rect.y + c.rect.h),
        }),
        { x: Infinity, y: -Infinity },
      );
      const ax = box.x + r() * 600;
      const ay = box.y + 400 + r() * 200;
      const arrow = hookArrow(ax, ay, ax + (r() - 0.5) * 300, ay + 300 + r() * 400);
      // 글씨는 **새로 쓴다.** 원래 장면의 획을 잘라 쓰면 표시 일부가 딸려 온다.
      const text = handwriting(ax - 40, ay - 90, 6, 32);
      const got = pointedIds({ ...sc, strokes: [...text, arrow] });
      if (got.length) bad.push(`seed ${seed} → ${JSON.stringify(got)}`);
    }
    expect(bad).toEqual([]);
  });

  /**
   * 표시를 아예 안 그리고 **질문만 쓴** 경우.
   *
   * 이때 짚은 카드가 나오면 안 된다 — 학생은 아무것도 가리키지 않았다.
   * 글씨 거르기가 무너지면 여기서 드러난다.
   */
  it("질문만 쓰면 아무 카드도 짚지 않는다", () => {
    const bad: string[] = [];
    for (let seed = 1000; seed < 1300; seed++) {
      const sc = makeScene(seed);
      const r = rng(seed);
      const textOnly = {
        ...sc,
        strokes: handwriting(
          Math.floor(r() * 400),
          Math.floor(r() * 200) + 40,
          6 + Math.floor(r() * 6),
          26 + r() * 24,
        ),
      };
      const got = pointedIds(textOnly);
      if (got.length) bad.push(`seed ${seed} → ${JSON.stringify(got)}`);
    }
    expect(bad).toEqual([]);
  });
});
