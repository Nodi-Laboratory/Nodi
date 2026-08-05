import { describe, expect, it } from "vitest";
import {
  enclosureRatio,
  groupStrokes,
  measureStroke,
  measureStrokes,
  pointInPoly,
  readGestures,
  type Pt,
} from "./inkShapes";
import type { PenStroke } from "./penPad";
import { hookArrow, oval, path, pieceArrow } from "./inkStrokes.fixture";

describe("pointInPoly", () => {
  const box: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it("안은 안, 밖은 밖", () => {
    expect(pointInPoly(box, 50, 50)).toBe(true);
    expect(pointInPoly(box, 150, 50)).toBe(false);
  });

  it("다각형을 우리가 닫는다 — 학생이 그린 원은 끝이 안 맞는다", () => {
    // 마지막 변이 없는 ㄷ자 점열. 닫아서 읽으면 안쪽이 생긴다.
    const open: Pt[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(pointInPoly(open, 50, 50)).toBe(true);
  });
});

describe("enclosureRatio", () => {
  it("감싼 사각형은 1", () => {
    const big = oval(100, 100, 200, 200).map((p) => ({ x: p.x, y: p.y }));
    expect(enclosureRatio(big, { x: 50, y: 50, w: 100, h: 100 })).toBe(1);
  });

  it("빗나간 고리는 0", () => {
    const away = oval(1000, 1000, 50, 50).map((p) => ({ x: p.x, y: p.y }));
    expect(enclosureRatio(away, { x: 0, y: 0, w: 100, h: 100 })).toBe(0);
  });

  /**
   * **이 테스트가 bbox를 버린 이유다.** 비스듬한 직선의 bbox는 커다란
   * 직사각형이라 예전 규칙("bbox가 카드 넓이의 70%를 덮으면 감쌈")으로는
   * 직선 하나가 동그라미가 됐다.
   */
  it("비스듬한 직선은 아무것도 감싸지 않는다", () => {
    const diagonal: Pt[] = [
      { x: 0, y: 0 },
      { x: 400, y: 400 },
    ];
    expect(enclosureRatio(diagonal, { x: 100, y: 100, w: 200, h: 200 })).toBe(0);
  });
});

describe("groupStrokes", () => {
  const gap = 20;

  it("끝이 닿는 획들을 하나로 묶는다", () => {
    const infos = measureStrokes(pieceArrow(0, 0, 300, 0));
    expect(groupStrokes(infos, gap)).toHaveLength(1);
  });

  it("떨어진 표시 둘은 안 묶는다", () => {
    const infos = measureStrokes([path([0, 0], [100, 0]), path([500, 0], [600, 0])]);
    expect(groupStrokes(infos, gap)).toHaveLength(2);
  });

  /**
   * **bbox가 크게 겹쳐도 끝이 멀면 남남이다.** 나란히 지나가는 두 선은 bbox가
   * 거의 포개지지만 별개의 표시다 — 넓이로 묶었으면 한 덩어리가 됐다.
   */
  it("나란히 떨어져 지나가는 획은 안 묶는다", () => {
    const infos = measureStrokes([path([0, 0], [300, 0]), path([0, 60], [300, 60])]);
    expect(groupStrokes(infos, gap)).toHaveLength(2);
  });

  /**
   * 반대로 **몸통 위에서 시작한 획은 묶인다.** 화살촉을 촉 끝이 아니라 조금
   * 뒤에서부터 그리는 사람이 많다 — 끝점이 몸통의 중간에 닿는다.
   */
  it("몸통 중간에서 시작한 곁가지도 묶인다", () => {
    const infos = measureStrokes([
      path([0, 0], [300, 0]),
      path([280, 2], [255, 20]),
    ]);
    expect(groupStrokes(infos, gap)).toHaveLength(1);
  });
});

describe("readGestures", () => {
  const opts = { joinGap: 20 };
  const read = (strokes: PenStroke[]) => readGestures(measureStrokes(strokes), opts);

  it("동그라미는 닫힌 고리다", () => {
    const [g] = read([oval(200, 200, 120, 80)]);
    expect(g.shape).toBe("circle");
    expect(g.closed).toBe(true);
    // 닫힌 고리에는 방향이 없다 — 끝과 시작이 같은 자리다.
    expect(g.tip).toBeNull();
  });

  it("두 번에 나눠 그린 동그라미도 닫힌 고리다", () => {
    const top = oval(200, 200, 120, 80, Math.PI);
    const bottom = oval(200, 200, 120, 80, Math.PI * 2, Math.PI);
    const [g] = read([top, bottom]);
    expect(g.shape).toBe("circle");
    expect(g.closed).toBe(true);
  });

  it("반원(C자)은 동그라미가 아니다", () => {
    const [g] = read([oval(200, 200, 120, 120, Math.PI)]);
    expect(g.closed).toBe(false);
  });

  /**
   * 한 획 화살표의 **끝점은 촉이 아니다** — 날개를 그리느라 되돌아 나온다.
   * 끝점을 그대로 촉으로 쓰면 가리킨 자리가 촉 뒤로 밀린다.
   */
  it("한 획 화살표의 촉은 끝점이 아니라 가장 멀리 나간 점이다", () => {
    const [g] = read([hookArrow(0, 0, 300, 0)]);
    expect(g.shape).toBe("arrow");
    expect(g.tip!.x).toBeCloseTo(300, 0);
    expect(g.tail!.x).toBeCloseTo(0, 0);
  });

  it("몸통과 촉을 따로 그린 화살표도 같은 방향을 가리킨다", () => {
    const gs = read(pieceArrow(0, 0, 300, 0));
    expect(gs).toHaveLength(1);
    expect(gs[0].shape).toBe("arrow");
    expect(gs[0].tip!.x).toBeCloseTo(300, 0);
    expect(gs[0].tail!.x).toBeCloseTo(0, 0);
  });

  it("촉을 어느 쪽에 그렸는지가 방향을 정한다 — 몸통을 그은 순서가 아니라", () => {
    // 몸통은 오른쪽→왼쪽으로 그었는데 촉은 오른쪽에 달았다.
    const shaft = path([300, 0], [0, 0]);
    const [w1, w2] = pieceArrow(0, 0, 300, 0).slice(1);
    const [g] = read([shaft, w1, w2]);
    expect(g.tip!.x).toBeCloseTo(300, 0);
    expect(g.tail!.x).toBeCloseTo(0, 0);
  });

  it("그냥 그은 선에는 촉이 없다", () => {
    const [g] = read([path([0, 0], [300, 0])]);
    expect(g.shape).toBe("underline");
    expect(g.tip!.x).toBeCloseTo(300, 0);
  });

  it("세로로 곧은 선은 밑줄이 아니다", () => {
    expect(read([path([0, 0], [0, 300])])[0].shape).toBe("line");
  });

  it("여러 번 덧그은 선은 덧칠이다", () => {
    const zig: (readonly [number, number])[] = [];
    for (let i = 0; i <= 8; i++) zig.push([i * 40, i % 2 ? 60 : 0]);
    expect(read([path(...zig)])[0].shape).toBe("scribble");
  });

  it("두 번 꺾인 선은 묶음표다", () => {
    expect(read([path([100, 0], [0, 0], [0, 300], [100, 300])])[0].shape).toBe(
      "bracket",
    );
  });

  it("떨어진 표시 둘은 표시 둘로 센다", () => {
    const gs = read([oval(100, 100, 60, 60), hookArrow(600, 100, 900, 100)]);
    expect(gs.map((g) => g.shape).sort()).toEqual(["arrow", "circle"]);
  });
});

describe("measureStroke", () => {
  it("빈 획은 null", () => {
    expect(measureStroke([])).toBeNull();
  });

  it("경로 길이와 직선 거리를 함께 잰다 — 그 비가 곧은 정도다", () => {
    const m = measureStroke(path([0, 0], [100, 0], [0, 0]))!;
    expect(m.len).toBe(200);
    expect(m.span).toBe(0);
  });
});
