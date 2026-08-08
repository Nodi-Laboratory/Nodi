/**
 * 고정 포트 연결선 (D210 4-1·4-2).
 *
 * 앵커를 일부러 고정했으므로 **예전에 포기했던 겹침 문제**를 다시 풀어야
 * 한다. 그 풀이가 실제로 도는지 값으로 못 박는다.
 */

import { describe, expect, it } from "vitest";
import {
  CUT_AT,
  cutPoint,
  fanStep,
  linkPath,
  PAD_X,
  PAD_Y,
  PORT_STEM,
  portFrom,
  portTo,
} from "./connector";

const box = (x: number, y: number, w = 560, h = 200) => ({ x, y, w, h });

describe("포트는 두 곳뿐이고 안 움직인다", () => {
  it("부모 포트는 언제나 아래 변 중앙", () => {
    const p = box(100, 100);
    const 자식이왼쪽 = portFrom(p);
    const 자식이오른쪽 = portFrom(p);
    expect(자식이왼쪽).toEqual(자식이오른쪽);
    // 패딩 상자 기준이다(hover 박스와 같은 상자).
    expect(자식이왼쪽.x).toBeCloseTo(100 - PAD_X + (560 + PAD_X * 2) / 2, 6);
    expect(자식이왼쪽.y).toBeCloseTo(100 + 200 + PAD_Y, 6);
  });

  it("자식 포트는 언제나 위 변 중앙", () => {
    const c = box(-400, 900, 300, 120);
    const t = portTo(c);
    expect(t.x).toBeCloseTo(-400 - PAD_X + (300 + PAD_X * 2) / 2, 6);
    expect(t.y).toBeCloseTo(900 - PAD_Y, 6);
  });

  it("카드를 어디에 두든 포트가 바뀌지 않는다", () => {
    const p = box(0, 0);
    const 왼쪽자식 = linkPath(p, box(-900, 600));
    const 오른쪽자식 = linkPath(p, box(900, 600));
    expect(왼쪽자식.a).toEqual(오른쪽자식.a);
  });
});

describe("공유 줄기", () => {
  it("아래 포트에서 수직으로 내려온다", () => {
    const g = linkPath(box(0, 0), box(700, 800));
    expect(g.stem.x).toBeCloseTo(g.a.x, 6);
    expect(g.stem.y).toBeCloseTo(g.a.y + PORT_STEM, 6);
  });

  it("자식이 몇이든 줄기는 같은 자리다 — 그래서 '공유'다", () => {
    const p = box(0, 0);
    const 셋 = [0, 1, 2].map((i) => linkPath(p, box(i * 700 - 700, 800), i, 3));
    expect(셋[0].stem).toEqual(셋[1].stem);
    expect(셋[1].stem).toEqual(셋[2].stem);
  });
});

describe("갈라짐은 자식 수에 따라 벌어진다", () => {
  it("자식이 하나면 안 벌린다", () => {
    expect(fanStep(1)).toBe(0);
    const g = linkPath(box(0, 0), box(0, 800), 0, 1);
    expect(g.c1.x).toBeCloseTo(g.stem.x, 6);
  });

  it("자식이 많을수록 넓게", () => {
    expect(fanStep(4)).toBeGreaterThan(fanStep(2));
    expect(fanStep(6)).toBeGreaterThan(fanStep(4));
  });

  it("자식이 셋이면 줄기 바로 뒤에서 서로 떨어진다", () => {
    // 같은 자리에 세 자식을 두어 **오직 부채만** 갈라 놓는 상황을 만든다.
    const p = box(0, 0);
    const 셋 = [0, 1, 2].map((i) => linkPath(p, box(0, 800), i, 3));
    const xs = 셋.map((g) => g.c1.x);
    expect(new Set(xs).size).toBe(3);
    expect(Math.abs(xs[0] - xs[2])).toBeGreaterThan(40);
  });

  it("가운데 자식은 곧게 내려간다", () => {
    const p = box(0, 0);
    const 가운데 = linkPath(p, box(0, 800), 1, 3);
    expect(가운데.c1.x).toBeCloseTo(가운데.stem.x, 6);
  });

  it("부채가 무한히 넓어지지는 않는다 — 옆 열을 침범하면 안 된다", () => {
    // 자식 20이어도 이웃 간격이 카드 폭 근처에서 멈춘다.
    expect(fanStep(20)).toBeLessThan(120);
  });
});

describe("끊기 버튼 자리", () => {
  it("공유 줄기 **밖**에 앉는다", () => {
    /**
     * 자리는 갈라진 구간의 **한가운데**다(D211 3, 사용자 지시 2026-08-08).
     *
     * 0.78(자식 쪽)이었던 근거는 "자식의 위 포트에는 선이 하나뿐이라 안
     * 겹친다"였다. 그건 **히트 판정이 선 자체일 때**의 이야기고, 지금은 줄기를
     * 뺀 넓은 히트 선이 어느 연결인지 가른다. 지켜야 할 것은 하나만 남는다 —
     * **줄기 위에는 절대 앉지 않는다**(거기서는 형제가 겹친다).
     */
    const g = linkPath(box(0, 0), box(0, 900));
    const 점 = cutPoint(g);
    expect(CUT_AT).toBeGreaterThan(0);
    expect(CUT_AT).toBeLessThan(1);
    // `pointOnFan`은 0이 줄기 끝이다 — 0보다 크면 이미 갈라진 뒤다.
    expect(점.y).toBeGreaterThan(g.stem.y);
    // 부모의 포트보다는 확실히 아래다(줄기 구간을 지났다).
    expect(점.y).toBeGreaterThan(g.a.y + PORT_STEM);
  });

  it("형제가 셋이어도 세 ✕가 서로 떨어져 있다", () => {
    const p = box(0, 0);
    const 점들 = [0, 1, 2].map((i) => cutPoint(linkPath(p, box(i * 700 - 700, 900), i, 3)));
    for (let i = 0; i < 점들.length; i++) {
      for (let j = i + 1; j < 점들.length; j++) {
        const d = Math.hypot(점들[i].x - 점들[j].x, 점들[i].y - 점들[j].y);
        expect(d).toBeGreaterThan(30);
      }
    }
  });
});
