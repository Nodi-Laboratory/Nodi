import { describe, expect, it } from "vitest";
import {
  buildInkScene,
  rectGap,
  rectOverlap,
  segmentHitsRect,
  type SceneCard,
} from "./inkScene";
import type { PenStroke } from "./penPad";

const OPTS = { cardMax: 5, nearPad: 120, boxMaxScale: 2.5 };

/** 두 점을 잇는 직선 획. */
function line(ax: number, ay: number, bx: number, by: number): PenStroke {
  return [
    { x: ax, y: ay, p: 0.6 },
    { x: bx, y: by, p: 0.6 },
  ];
}

function card(id: string, x: number, y: number, w = 200, h = 100): SceneCard {
  return { id, kind: "concept", title: id, body: `${id} 본문`, rect: { x, y, w, h } };
}

describe("segmentHitsRect", () => {
  it("사각형을 관통하는 선분을 잡는다", () => {
    expect(segmentHitsRect(0, 50, 300, 50, { x: 100, y: 0, w: 100, h: 100 })).toBe(true);
  });

  it("사각형 안에서 끝나는 선분도 잡는다", () => {
    expect(segmentHitsRect(0, 50, 150, 50, { x: 100, y: 0, w: 100, h: 100 })).toBe(true);
  });

  it("비껴가는 선분은 안 잡는다", () => {
    expect(segmentHitsRect(0, 500, 300, 500, { x: 100, y: 0, w: 100, h: 100 })).toBe(false);
  });
});

describe("rectGap", () => {
  it("겹치면 0", () => {
    expect(rectGap({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 })).toBe(0);
  });

  it("가로로 떨어진 만큼", () => {
    expect(rectGap({ x: 0, y: 0, w: 100, h: 100 }, { x: 150, y: 0, w: 100, h: 100 })).toBe(50);
  });
});

describe("rectOverlap", () => {
  it("겹치는 넓이", () => {
    expect(
      rectOverlap({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 }),
    ).toBe(2500);
  });

  it("안 겹치면 0", () => {
    expect(
      rectOverlap({ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 0, w: 100, h: 100 }),
    ).toBe(0);
  });

  it("변이 닿기만 한 것은 0", () => {
    expect(
      rectOverlap({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 }),
    ).toBe(0);
  });
});

describe("buildInkScene", () => {
  it("획이 없으면 null", () => {
    expect(buildInkScene([], [card("A", 0, 0)], OPTS)).toBeNull();
  });

  /**
   * **이 테스트가 알고리즘의 이유다.** 대각선 화살표의 bbox는 커다란
   * 직사각형이라, bbox로 판정하면 화살표가 지나가지도 않은 구석 카드가
   * 접촉으로 잡힌다.
   */
  it("대각선 획의 bbox 구석에 있는 카드를 접촉으로 잡지 않는다", () => {
    const arrow = line(0, 0, 2000, 2000);
    const corner = card("구석", 0, 1800, 200, 200); // bbox 안, 대각선에서 멀다
    const scene = buildInkScene([arrow], [corner], OPTS)!;
    const picked = scene.cards.find((c) => c.id === "구석");
    expect(picked?.touched ?? false).toBe(false);
  });

  it("관통당한 카드는 접촉이다", () => {
    const arrow = line(0, 50, 400, 50);
    const scene = buildInkScene([arrow], [card("맞음", 200, 0)], OPTS)!;
    expect(scene.cards[0].touched).toBe(true);
  });

  it("닿지 않았지만 가까운 카드는 근접으로 잡힌다", () => {
    const ink = line(0, 0, 50, 50);
    const near = card("옆", 100, 0); // 획 bbox에서 50px 이내
    const scene = buildInkScene([ink], [near], OPTS)!;
    expect(scene.cards).toHaveLength(1);
    expect(scene.cards[0].touched).toBe(false);
  });

  it("근접 반경 밖의 카드는 안 잡는다", () => {
    const ink = line(0, 0, 50, 50);
    const far = card("멀다", 5000, 5000);
    expect(buildInkScene([ink], [far], OPTS)!.cards).toHaveLength(0);
  });

  it("상한을 넘으면 접촉을 먼저 남기고 잘린 수를 알린다", () => {
    const ink = line(0, 50, 400, 50);
    // 근접 셋은 반경(120) 안에 둔다 — 획 bbox는 y 32~68이므로 y=150이면 82px.
    const cards = [
      card("접촉", 200, 0),
      card("근접1", 0, 150),
      card("근접2", 150, 150),
      card("근접3", 300, 150),
    ];
    const scene = buildInkScene([ink], cards, { ...OPTS, cardMax: 2 })!;
    expect(scene.cards).toHaveLength(2);
    expect(scene.cards.some((c) => c.id === "접촉")).toBe(true);
    expect(scene.dropped).toBe(2);
  });

  it("번호는 읽는 순서(위→아래, 같은 줄이면 왼→오른쪽)로 매긴다", () => {
    const ink = line(400, 400, 450, 450);
    const cards = [
      card("아래", 300, 600),
      card("위오른쪽", 500, 300),
      card("위왼쪽", 200, 300),
    ];
    const scene = buildInkScene([ink], cards, { ...OPTS, nearPad: 600 })!;
    expect(scene.cards.map((c) => c.id)).toEqual(["위왼쪽", "위오른쪽", "아래"]);
    expect(scene.cards.map((c) => c.n)).toEqual([1, 2, 3]);
  });

  it("상자는 획 bbox의 boxMaxScale배를 넘지 않는다", () => {
    const ink = line(0, 0, 100, 100);
    const huge = card("큰카드", 150, 0, 4000, 4000);
    const scene = buildInkScene([ink], [huge], OPTS)!;
    expect(scene.capture.w).toBeLessThanOrEqual(scene.inkBox.w * OPTS.boxMaxScale + 0.01);
    expect(scene.capture.h).toBeLessThanOrEqual(scene.inkBox.h * OPTS.boxMaxScale + 0.01);
  });

  it("상자를 잘라도 획은 통째로 들어간다", () => {
    // 클램프가 획을 잘라 내면 OCR과 VLM이 서로 다른 질문을 보게 된다.
    const ink = line(0, 0, 100, 100);
    const huge = card("큰카드", 150, 0, 4000, 4000);
    const { capture, inkBox } = buildInkScene([ink], [huge], OPTS)!;
    expect(capture.x).toBeLessThanOrEqual(inkBox.x);
    expect(capture.y).toBeLessThanOrEqual(inkBox.y);
    expect(capture.x + capture.w).toBeGreaterThanOrEqual(inkBox.x + inkBox.w);
    expect(capture.y + capture.h).toBeGreaterThanOrEqual(inkBox.y + inkBox.h);
  });

  /**
   * **종료가 알고리즘의 성질이다.** 상자를 키운 결과로 카드를 다시 주우면
   * 조밀한 캔버스에서 전체를 삼킨다.
   */
  /**
   * **판정 여백을 그림에 얹으면 안 된다.** 얹으면 도식의 상자가 실제 카드보다
   * 사방으로 커져서 닿지 않은 획이 닿은 것처럼 그려지고, 그 그림으로 판정하는
   * 것이 VLM이라 그 차이가 그대로 답이 된다.
   */
  it("고른 카드의 rect는 준 그대로다 — 판정 여백이 안 묻는다", () => {
    const ink = line(0, 50, 400, 50);
    const c = card("맞음", 200, 0);
    const scene = buildInkScene([ink], [c], OPTS)!;
    expect(scene.cards[0].rect).toEqual(c.rect);
  });

  it("여백 덕에 살짝 빗나간 획도 접촉으로 본다", () => {
    // 카드 왼쪽 변에서 8px 떨어진 세로획 — 눈으로는 닿아 보이는 거리다.
    const ink = line(192, 0, 192, 100);
    const scene = buildInkScene([ink], [card("옆", 200, 0)], OPTS)!;
    expect(scene.cards[0].touched).toBe(true);
  });

  it("자리 이름을 붙인다 — 번호를 못 읽는 모델의 두 번째 단서", () => {
    // 같은 줄 셋 + 아랫줄 하나.
    const ink = line(300, 300, 340, 340);
    const cards = [
      card("왼", 0, 200),
      card("가운데", 250, 200),
      card("오른", 500, 200),
      card("아래", 250, 400),
    ];
    const scene = buildInkScene([ink], cards, { ...OPTS, nearPad: 400, cardMax: 8 })!;
    const by = new Map(scene.cards.map((c) => [c.id, c.where]));
    expect(by.get("왼")).toBe("맨 윗줄 왼쪽");
    expect(by.get("가운데")).toBe("맨 윗줄 가운데");
    expect(by.get("오른")).toBe("맨 윗줄 오른쪽");
    expect(by.get("아래")).toBe("맨 아랫줄 가운데");
  });

  it("한 줄뿐이면 줄 이름을 붙이지 않는다", () => {
    const ink = line(300, 300, 340, 340);
    const scene = buildInkScene([ink], [card("혼자", 250, 250)], OPTS)!;
    expect(scene.cards[0].where).toBe("가운데");
  });

  it("기각된 후보도 판정 기록에 남는다", () => {
    // 뽑힌 것만 남기면 "왜 저 카드는 안 들어갔지"에 답할 근거가 없다.
    const ink = line(0, 50, 400, 50);
    const cards = [
      card("접촉", 200, 0),
      card("근접", 0, 150),
      card("멀다", 5000, 5000),
    ];
    const scene = buildInkScene([ink], cards, { ...OPTS, cardMax: 1 })!;
    const by = new Map(scene.trace.map((t) => [t.id, t]));
    expect(scene.trace).toHaveLength(3);
    expect(by.get("접촉")!.verdict).toBe("touched");
    expect(by.get("접촉")!.n).toBe(1);
    expect(by.get("근접")!.verdict).toBe("over_cap");
    expect(by.get("근접")!.n).toBeNull();
    expect(by.get("멀다")!.verdict).toBe("too_far");
  });

  it("상자가 잘렸는지 알려 준다", () => {
    const ink = line(0, 0, 100, 100);
    // 획 상자는 여백 포함 136×136 → 상한은 340×340.
    // 작은 카드를 품어도 168×136이라 안 잘린다.
    expect(buildInkScene([ink], [card("옆", 100, 0, 50, 50)], OPTS)!.clamped).toBe(
      false,
    );
    expect(
      buildInkScene([ink], [card("큰카드", 150, 0, 4000, 4000)], OPTS)!.clamped,
    ).toBe(true);
  });

  it("키운 상자 안에 들어온 카드를 다시 줍지 않는다", () => {
    const ink = line(0, 0, 100, 100);
    const anchor = card("근접", 150, 0); // 근접으로 잡힌다 → 상자가 커진다
    const later = card("나중", 420, 0); // 원래 bbox에서는 멀다
    const scene = buildInkScene([ink], [anchor, later], OPTS)!;
    expect(scene.cards.map((c) => c.id)).toEqual(["근접"]);
  });
});
