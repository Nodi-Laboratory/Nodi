/**
 * 연결선 기하 테스트.
 *
 * 사용자가 보낸 화면의 문제 둘을 그대로 못 박는다:
 *   1. 시작점이 늘 같은 자리라 답이 둘일 때 선이 겹쳐 지나갔다.
 *   2. 끝점이 박스 **안쪽**에 박혀 어디로 들어가는지 안 보였다.
 */

import { describe, expect, it } from "vitest";
import {
  END_GAP,
  PAD_X,
  anchor,
  attachPath,
  edgeMidpoints,
  linkGeometry,
  midpoint,
  padded,
} from "./connector";
import type { Rect } from "./rect";

const box = (x: number, y: number, w = 460, h = 200): Rect => ({ x, y, w, h });

/** 점이 사각형 내부(경계 포함)에 있나. */
function inside(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

describe("붙는 변은 상대 위치가 정한다", () => {
  const parent = box(0, 0);

  it("답이 오른쪽이면 오른쪽 변에서 나가 왼쪽 변으로 들어간다", () => {
    const g = linkGeometry(parent, box(900, 0));
    expect(g.sideA).toBe("right");
    expect(g.sideB).toBe("left");
  });

  it("답이 아래면 아래 변에서 나가 윗 변으로 들어간다", () => {
    const g = linkGeometry(parent, box(0, 900));
    expect(g.sideA).toBe("bottom");
    expect(g.sideB).toBe("top");
  });

  it("답이 위면 윗 변에서 나가 아래 변으로 들어간다", () => {
    // 사용자 이미지의 상황 — 답을 질문 위쪽으로 끌어 올린 경우.
    const g = linkGeometry(parent, box(0, -900));
    expect(g.sideA).toBe("top");
    expect(g.sideB).toBe("bottom");
  });

  it("답이 왼쪽이면 왼쪽 변에서 나간다", () => {
    const g = linkGeometry(parent, box(-900, 0));
    expect(g.sideA).toBe("left");
    expect(g.sideB).toBe("right");
  });
});

describe("끝점은 패딩 상자 밖에 선다", () => {
  const cases: [Rect, Rect][] = [
    [box(0, 0), box(900, 0)],
    [box(0, 0), box(0, 900)],
    [box(0, 0), box(0, -900)],
    [box(0, 0), box(-900, 40)],
    [box(0, 0, 200, 120), box(300, 800, 460, 900)],
  ];

  it("글자 사각형 안에 들어가지 않는다", () => {
    for (const [p, c] of cases) {
      const g = linkGeometry(p, c);
      expect(inside(g.a, p), `시작점이 부모 안: ${JSON.stringify(g.a)}`).toBe(false);
      expect(inside(g.b, c), `끝점이 자식 안: ${JSON.stringify(g.b)}`).toBe(false);
    }
  });

  it("**패딩 상자** 안에도 들어가지 않는다 — 눈에 보이는 상자가 기준이다", () => {
    for (const [p, c] of cases) {
      const g = linkGeometry(p, c);
      expect(inside(g.a, padded(p)), `시작점이 부모 패딩 안`).toBe(false);
      expect(inside(g.b, padded(c)), `끝점이 자식 패딩 안`).toBe(false);
    }
  });

  it("패딩 상자 변에서 정확히 END_GAP만큼 떨어져 있다", () => {
    const g = linkGeometry(box(0, 0), box(900, 0));
    // 글자 오른쪽 변 460 → 패딩 상자 476 → 끝점 480.
    expect(g.a.x).toBe(460 + PAD_X + END_GAP);
    expect(g.b.x).toBe(900 - PAD_X - END_GAP);
  });

  it("패딩만큼 떨어지므로 글자에서 END_GAP보다 멀다", () => {
    // "더 바깥부분에 위치하도록" — 요구가 지켜지는지 수치로 못 박는다.
    const g = linkGeometry(box(0, 0), box(900, 0));
    expect(g.a.x - 460).toBeGreaterThan(END_GAP);
    expect(g.a.x - 460).toBe(PAD_X + END_GAP);
  });
});

describe("같은 부모의 답이 둘이면 시작점이 갈린다", () => {
  it("위로 간 답과 아래로 간 답의 시작점이 다르다", () => {
    const parent = box(0, 0);
    const up = linkGeometry(parent, box(900, -600));
    const down = linkGeometry(parent, box(900, 600));
    // 예전에는 둘 다 (460, min(h/2,60))로 같은 점이었다 — 그래서 겹쳤다.
    expect(up.a.y).not.toBe(down.a.y);
    expect(up.a.y).toBeLessThan(down.a.y);
  });

  it("변 위 지점이 상대 쪽을 향해 미끄러진다", () => {
    const parent = box(0, 0, 460, 400);
    // 상대가 아래쪽에 있으면 시작점도 아래쪽 — 다만 모서리에는 안 붙는다.
    const g = anchor(parent, { x: 900, y: 380 });
    expect(g.side).toBe("right");
    expect(g.y).toBeGreaterThan(200);
    expect(g.y).toBeLessThanOrEqual(400);
  });

  it("박스가 여백 두 배보다 좁아도 변 안에 머문다", () => {
    // EDGE_INSET(18)의 두 배보다 낮은 박스 — clamp의 lo > hi 경로.
    const thin = box(0, 0, 460, 20);
    const g = anchor(thin, { x: 900, y: 5000 });
    expect(g.y).toBeGreaterThanOrEqual(0);
    expect(g.y).toBeLessThanOrEqual(20);
  });
});

describe("라벨 자리", () => {
  /** 3차 베지어를 정의대로 t에서 계산한다(midpoint와 독립된 경로). */
  function bezier(g: ReturnType<typeof linkGeometry>, t: number) {
    const u = 1 - t;
    const f = (a: number, b: number, c: number, d: number) =>
      u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
    return {
      x: f(g.a.x, g.c1.x, g.c2.x, g.b.x),
      y: f(g.a.y, g.c1.y, g.c2.y, g.b.y),
    };
  }

  it("정확히 곡선 위(t=0.5)에 있다", () => {
    const cases: [Rect, Rect][] = [
      [box(0, 0), box(900, 0)],
      [box(0, 0), box(0, 900)],
      [box(0, 0, 1000, 100), box(1200, 200, 100, 1000)],
    ];
    for (const [p, c] of cases) {
      const g = linkGeometry(p, c);
      const m = midpoint(g);
      const b = bezier(g, 0.5);
      expect(m.x).toBeCloseTo(b.x, 9);
      expect(m.y).toBeCloseTo(b.y, 9);
    }
  });

  it("휜 연결선에서는 두 끝의 중점과 다르다", () => {
    // 나가는 변과 들어오는 변이 **직각**이면(아래 → 왼쪽) 곡선이 한쪽으로
    // 부풀어, 현의 중점은 선 위에 있지 않다. 라벨을 거기 두면 허공에 뜬다.
    const g = linkGeometry(box(0, 0, 1000, 100), box(1200, 200, 100, 1000));
    expect(g.sideA).toBe("bottom");
    expect(g.sideB).toBe("left");
    const m = midpoint(g);
    const chord = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
    expect(Math.hypot(m.x - chord.x, m.y - chord.y)).toBeGreaterThan(1);
  });

  it("변이 정반대면 중점과 같다(대칭이라 당연하다)", () => {
    const g = linkGeometry(box(0, 0), box(900, 0));
    const m = midpoint(g);
    expect(m.x).toBeCloseTo((g.a.x + g.b.x) / 2, 9);
    expect(m.y).toBeCloseTo((g.a.y + g.b.y) / 2, 9);
  });
});

/**
 * 곁들이(사진·영상)의 연결선 — 최단 변-중앙 쌍 (사용자 지시 2026-08-12).
 *
 * 트리 간선처럼 아래 포트에 묶여 있으면, 카드 **오른쪽**에 나란히 붙은 상자로
 * 가는 선이 카드 밑으로 한참 내려갔다 되올라온다. 상자는 트리 노드가 아니라
 * 카드의 제약을 받지 않으므로 자리를 고정할 이유가 없다.
 */
describe("곁들이 연결선", () => {
  const 카드 = { x: 0, y: 0, w: 400, h: 300 };

  it("오른쪽에 붙으면 오른쪽 변 ↔ 왼쪽 변으로 잇는다", () => {
    const g = attachPath(카드, { x: 600, y: 40, w: 200, h: 160 });
    // 카드의 오른쪽 변 중앙에서 나간다(패딩 상자 기준, END_GAP만큼 바깥).
    expect(g.a.x).toBeGreaterThan(카드.x + 카드.w);
    expect(g.a.y).toBeCloseTo(카드.y + 카드.h / 2, 5);
    // 상자의 왼쪽 변 중앙으로 들어간다.
    expect(g.b.x).toBeLessThan(600);
    expect(g.b.y).toBeCloseTo(40 + 160 / 2, 5);
  });

  it("위에 붙으면 위 변 ↔ 아래 변으로 잇는다", () => {
    const g = attachPath(카드, { x: 60, y: -500, w: 200, h: 160 });
    expect(g.a.y).toBeLessThan(카드.y);
    expect(g.a.x).toBeCloseTo(카드.x + 카드.w / 2, 5);
    expect(g.b.y).toBeGreaterThan(-500 + 160);
  });

  it("여덟 자리 조합 중 **가장 짧은** 쌍을 고른다", () => {
    const 상자 = { x: -700, y: 700, w: 200, h: 160 };
    const g = attachPath(카드, 상자);
    const 길이 = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y);
    for (const a of edgeMidpoints(카드)) {
      for (const b of edgeMidpoints(상자)) {
        // END_GAP(양쪽 4px)만큼 차이 나므로 여유를 두고 비교한다.
        expect(길이).toBeLessThanOrEqual(Math.hypot(b.x - a.x, b.y - a.y) + 12);
      }
    }
  });

  it("줄기가 없다 — 나눠 쓸 형제가 없다", () => {
    const g = attachPath(카드, { x: 600, y: 0, w: 200, h: 160 });
    expect(g.stem).toEqual(g.a);
  });
});
