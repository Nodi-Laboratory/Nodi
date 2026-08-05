import { describe, expect, it } from "vitest";
import {
  buildInkScene,
  POINTING_KINDS,
  rectGap,
  rectOverlap,
  segmentHitsRect,
  type SceneCard,
} from "./inkScene";
import { handwriting, hookArrow, oval, pieceArrow } from "./inkStrokes.fixture";
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

  it("상자를 잘라도 표시는 통째로 들어간다", () => {
    // 클램프가 표시를 잘라 내면 OCR과 VLM이 서로 다른 질문을 보게 된다.
    const ink = line(0, 0, 100, 100);
    const huge = card("큰카드", 150, 0, 4000, 4000);
    const { capture, inkBox } = buildInkScene([ink], [huge], OPTS)!;
    expect(capture.x).toBeLessThanOrEqual(inkBox.x);
    expect(capture.y).toBeLessThanOrEqual(inkBox.y);
    expect(capture.x + capture.w).toBeGreaterThanOrEqual(inkBox.x + inkBox.w);
    expect(capture.y + capture.h).toBeGreaterThanOrEqual(inkBox.y + inkBox.h);
  });

  it("틀 잡기 점은 그리지 않지만, 상자가 커질 여유는 그것이 정한다", () => {
    // 학생이 멀리 점을 찍는 이유는 "여기까지 봐 줘"다. 그 점까지 그리면 그림의
    // 대부분이 빈 하늘이 되고, 반대로 그 점을 허용치에서까지 빼면 카드가 잘린다.
    const ellipse = line(300, 300, 900, 300);
    const dot: PenStroke = [
      { x: 0, y: 0, p: 0.6 },
      { x: 6, y: 6, p: 0.6 },
    ];
    const far = card("멀다", 1200, 280, 300, 100);
    const scene = buildInkScene([dot, ellipse], [far], { ...OPTS, nearPad: 400 })!;
    // 점은 그림에서 빠진다.
    expect(scene.marks).toHaveLength(1);
    // 그래도 상자는 카드를 품는다(점이 허용치를 넓혀 준 덕이다).
    expect(scene.capture.x + scene.capture.w).toBeGreaterThanOrEqual(1500);
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

/**
 * 학생이 실제로 그리는 장면들.
 *
 * 여기 있는 것이 이 기능의 계약이다 — 위의 테스트가 "상자를 어떻게 자르나"라면
 * 이쪽은 **"무엇을 짚었다고 볼 것인가"**다. 넓은 카드(560×120)를 쓰는 이유는
 * 그것이 실제 캔버스 아이템 크기이고, 표시의 크기 잣대가 그림 대각선에 비례하기
 * 때문이다(작은 모형으로 재면 통과하는 규칙이 실물에서 무너진다).
 */
describe("buildInkScene — 표시 읽기", () => {
  const WIDE = { ...OPTS, cardMax: 8, nearPad: 400 };
  const wide = (id: string, x: number, y: number): SceneCard =>
    card(id, x, y, 560, 120);

  /** 카드 번호 → 판정. 읽기 좋게 뒤집는다. */
  const marks = (s: ReturnType<typeof buildInkScene>) =>
    new Map(s!.cards.map((c) => [c.id, c.mark]));

  it("카드를 감싼 동그라미는 감쌈이다", () => {
    const cards = [wide("지질학", 0, 0), wide("천문학", 0, 300)];
    const scene = buildInkScene([oval(280, 60, 330, 100)], cards, WIDE)!;
    expect(marks(scene).get("지질학")).toBe("circled");
    expect(marks(scene).get("천문학")).toBe("near");
    expect(scene.gestures[0].shape).toBe("circle");
    expect(scene.gestures[0].encloses).toEqual([1]);
  });

  /**
   * **예전 규칙이 여기서 틀렸다.** 대각선 획의 bbox는 커다란 직사각형이라
   * "bbox가 카드 넓이의 70%를 덮으면 감쌈"으로는 직선 하나가 두 카드를
   * 동그라미 친 것이 됐다.
   */
  it("비스듬히 지나간 선은 감쌈이 아니다", () => {
    const cards = [wide("지질학", 0, 0), wide("천문학", 600, 400)];
    const scene = buildInkScene([line(0, 0, 1160, 520)], cards, WIDE)!;
    const m = marks(scene);
    expect(m.get("지질학")).not.toBe("circled");
    expect(m.get("천문학")).not.toBe("circled");
  });

  it("큰 동그라미 하나가 카드 둘을 함께 감쌀 수 있다", () => {
    const cards = [wide("지질학", 0, 0), wide("천문학", 0, 200)];
    const scene = buildInkScene([oval(280, 160, 380, 260)], cards, WIDE)!;
    expect(scene.gestures[0].encloses).toEqual([1, 2]);
    expect([...marks(scene).values()]).toEqual(["circled", "circled"]);
  });

  /**
   * **화살표에는 방향이 있다.** 카드 1에서 카드 3으로 그은 화살표에서 학생이
   * 묻는 것은 카드 3이다 — 둘 다 대상으로 치면 SOLAR가 둘 다 설명하고,
   * 이어 묻기의 부모도 엉뚱한 쪽에 붙는다.
   */
  it("화살표는 출발한 카드와 가리킨 카드를 가른다", () => {
    const cards = [wide("지질학", 0, 0), wide("생명공학", 0, 500)];
    const scene = buildInkScene(
      [hookArrow(280, 100, 280, 520)],
      cards,
      WIDE,
    )!;
    const m = marks(scene);
    expect(m.get("지질학")).toBe("linked");
    expect(m.get("생명공학")).toBe("pointed");
    const [g] = scene.gestures;
    expect(g.shape).toBe("arrow");
    expect(g.from).toEqual([1]);
    expect(g.points).toEqual([2]);
  });

  it("몸통과 촉을 따로 그려도 같은 방향으로 읽는다", () => {
    const cards = [wide("지질학", 0, 0), wide("생명공학", 0, 500)];
    const scene = buildInkScene(pieceArrow(280, 100, 280, 520), cards, WIDE)!;
    const m = marks(scene);
    expect(m.get("지질학")).toBe("linked");
    expect(m.get("생명공학")).toBe("pointed");
  });

  it("서로 다른 카드를 가리킨 화살표 둘을 둘로 센다", () => {
    const cards = [
      wide("지질학", 0, 0),
      wide("천문학", 0, 250),
      wide("생명공학", 0, 500),
    ];
    const scene = buildInkScene(
      [hookArrow(900, 300, 600, 60), hookArrow(900, 340, 600, 560)],
      cards,
      WIDE,
    )!;
    expect(scene.gestures).toHaveLength(2);
    const m = marks(scene);
    expect(m.get("지질학")).toBe("pointed");
    expect(m.get("생명공학")).toBe("pointed");
    expect(m.get("천문학")).not.toBe("pointed");
  });

  it("카드 안 한 구절에 그은 밑줄은 그 카드를 짚은 것이다", () => {
    const cards = [wide("지질학", 0, 0), wide("천문학", 0, 300)];
    const scene = buildInkScene([line(60, 70, 380, 72)], cards, WIDE)!;
    expect(marks(scene).get("지질학")).toBe("within");
    expect(scene.gestures[0].within).toEqual([1]);
  });

  /**
   * **화살표 몸통이 지나간 것은 짚은 것이 아니다.** 이 구분이 없으면 카드
   * 사이를 가로질러 간 화살표가 지나친 카드까지 전부 딸려 간다.
   */
  it("스쳐 지나간 카드는 짚은 것이 아니다", () => {
    const cards = [
      wide("지질학", 0, 0),
      wide("천문학", 0, 250),
      wide("생명공학", 0, 500),
    ];
    const scene = buildInkScene([hookArrow(280, -60, 280, 560)], cards, WIDE)!;
    const m = marks(scene);
    expect(m.get("천문학")).toBe("crossed");
    expect(m.get("생명공학")).toBe("pointed");
    expect(scene.gestures[0].crosses).toContain(2);
  });

  /**
   * **이것이 가장 중요한 테스트다.** 학생이 쓴 질문 글씨도 획이다. 그걸 표시로
   * 세면 **화살표를 긋지 않았는데도** 카드 옆에 질문을 쓴 것만으로 그 카드를
   * 짚은 것이 된다 — 그리고 그 오답은 그럴싸해서 아무도 못 잡는다.
   */
  it("질문 글씨는 카드를 짚지 않는다", () => {
    const cards = [wide("지질학", 0, 0), wide("천문학", 0, 400)];
    const scene = buildInkScene(
      // 카드 1 바로 아래에 질문을 쓰고, 카드 2를 동그라미 쳤다.
      [...handwriting(20, 150, 7), oval(280, 460, 330, 100)],
      cards,
      WIDE,
    )!;
    const m = marks(scene);
    expect(m.get("천문학")).toBe("circled");
    expect(m.get("지질학")).toBe("near");
    // 표시는 동그라미 하나뿐 — 글자 35획이 표시로 세어지면 안 된다.
    expect(scene.gestures).toHaveLength(1);
    // 그래도 **그려지기는 한다** — 모델이 학생이 뭘 물었는지도 봐야 한다.
    expect(scene.marks.length).toBeGreaterThan(30);
  });

  /**
   * **실사용에서 가장 흔한 모양이다** — "이거 두개 비교해줘"라고 쓰고 그
   * 자리에서 두 카드로 화살표를 뻗는다. 두 화살표의 꼬리가 겹치는데, 예전에는
   * 그 둘이 **한 표시로 뭉치고** 짧은 쪽이 긴 쪽의 화살촉으로 오인됐다
   * (사용자 보고 2026-08-05: 두 카드를 가리켰는데 왼쪽 엉뚱한 카드가 나왔다).
   */
  it("같은 자리에서 출발한 화살표 둘을 둘로 센다", () => {
    const cards = [wide("지질학", 0, 0), wide("천문학", 700, 0), wide("생명공학", 1400, 0)];
    const scene = buildInkScene(
      [
        ...handwriting(820, 700, 7),
        hookArrow(880, 660, 900, 200),
        hookArrow(900, 660, 1600, 200),
      ],
      cards,
      WIDE,
    )!;
    expect(scene.gestures).toHaveLength(2);
    const m = marks(scene);
    expect(m.get("천문학")).toBe("pointed");
    expect(m.get("생명공학")).toBe("pointed");
    expect(m.get("지질학")).toBe("near");
  });

  /**
   * **그리는 순서로 방향을 정하면 반이 틀린다.** 학생은 질문에서 카드로도
   * 긋고 카드에서 질문으로도 긋는다 — 어느 쪽이든 묻는 대상은 카드다.
   */
  it("카드에서 질문 쪽으로 그어도 카드를 짚은 것이다", () => {
    const cards = [wide("지질학", 0, 0), wide("천문학", 700, 0)];
    const scene = buildInkScene(
      [...handwriting(820, 700, 7), hookArrow(900, 200, 880, 660)],
      cards,
      WIDE,
    )!;
    expect(marks(scene).get("천문학")).toBe("pointed");
    expect(scene.gestures[0].points).toEqual([2]);
  });

  /**
   * **학생은 화살표를 카드에 박지 않는다** — 한참 앞에서 멈춘다. 실측
   * 2026-08-05: 60px씩 못 미친 화살표 둘이 짚은 카드 0개로 나왔고, 그러면
   * 프롬프트가 "아무것도 안 짚었다"고 말해 모델이 지어낸다.
   */
  it("못 미쳐 멈춘 화살표도 겨눈 카드를 짚는다", () => {
    const cards = [wide("지질학", 0, 0), wide("천문학", 0, 900)];
    // 카드 2의 위쪽 변에서 220px 못 미쳐 멈춘다.
    const scene = buildInkScene([hookArrow(280, 200, 280, 680)], cards, WIDE)!;
    expect(marks(scene).get("천문학")).toBe("pointed");
  });

  /**
   * **"가장 가까운 카드"로 때우면 안 된다.** 옆으로 비껴 있는 카드가 더
   * 가까울 수 있고, 그건 학생이 겨눈 것이 아니다.
   */
  it("겨누지 않았으면 더 가까워도 안 집는다", () => {
    const cards = [
      // 촉에서 104px — 겨눈 카드(248px)보다 **훨씬 가깝다.** 다만 화살표는
      // 아래로 향하고 이 카드는 오른쪽 옆에 비껴 있다.
      wide("옆에있음", 400, 620),
      wide("겨눈카드", 0, 900),
    ];
    const scene = buildInkScene([hookArrow(280, 200, 280, 640)], cards, WIDE)!;
    const m = marks(scene);
    expect(m.get("겨눈카드")).toBe("pointed");
    expect(m.get("옆에있음")).not.toBe("pointed");
  });

  it("짚은 카드는 POINTING_KINDS로 걸러진다 — 출발점과 스침은 빠진다", () => {
    const cards = [wide("지질학", 0, 0), wide("생명공학", 0, 500)];
    const scene = buildInkScene([hookArrow(280, 100, 280, 520)], cards, WIDE)!;
    const pointed = scene.cards
      .filter((c) => POINTING_KINDS.includes(c.mark))
      .map((c) => c.n);
    expect(pointed).toEqual([2]);
  });
});
