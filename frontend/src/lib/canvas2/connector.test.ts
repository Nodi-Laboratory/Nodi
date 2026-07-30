/**
 * 연결선 기하 테스트.
 *
 * 사용자가 보낸 화면의 문제 둘을 그대로 못 박는다:
 *   1. 시작점이 늘 같은 자리라 답이 둘일 때 선이 겹쳐 지나갔다.
 *   2. 끝점이 박스 **안쪽**에 박혀 어디로 들어가는지 안 보였다.
 */

import { describe, expect, it } from "vitest";
import { END_GAP, anchor, linkGeometry, midpoint } from "./connector";
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

describe("끝점은 박스 밖에 선다", () => {
  it("양끝 모두 어느 박스 안에도 들어가지 않는다", () => {
    const cases: [Rect, Rect][] = [
      [box(0, 0), box(900, 0)],
      [box(0, 0), box(0, 900)],
      [box(0, 0), box(0, -900)],
      [box(0, 0), box(-900, 40)],
      [box(0, 0, 200, 120), box(300, 800, 460, 900)],
    ];
    for (const [p, c] of cases) {
      const g = linkGeometry(p, c);
      expect(inside(g.a, p), `시작점이 부모 안: ${JSON.stringify(g.a)}`).toBe(false);
      expect(inside(g.b, c), `끝점이 자식 안: ${JSON.stringify(g.b)}`).toBe(false);
    }
  });

  it("정확히 END_GAP만큼 떨어져 있다", () => {
    const g = linkGeometry(box(0, 0), box(900, 0));
    // 오른쪽 변이 x=460이므로 시작점은 467.
    expect(g.a.x).toBe(460 + END_GAP);
    expect(g.b.x).toBe(900 - END_GAP);
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
