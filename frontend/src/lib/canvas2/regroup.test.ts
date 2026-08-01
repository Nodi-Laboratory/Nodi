/**
 * 재배치 불변식 (D143).
 *
 * 사용자 요구를 그대로 못 박는다 — "모든 태그들이 각자의 현재 위치에서
 * **최소한으로** 움직여서 서로 **구분되는** 위치로."
 */

import { describe, expect, it } from "vitest";
import { groupKeys, regroup, TAG_GAP, type RegroupItem } from "./regroup";

function item(p: Partial<RegroupItem> & { id: string }): RegroupItem {
  return {
    tag: null,
    parentItemId: null,
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    ...p,
  };
}

/** 재배치 결과를 반영한 최종 좌표. */
function applied(items: readonly RegroupItem[], moves: Map<string, { x: number; y: number }>) {
  return items.map((i) => ({ ...i, ...(moves.get(i.id) ?? { x: i.x, y: i.y }) }));
}

/** 태그가 다른 두 글이 `gap`보다 가까운가. */
function tooClose(items: readonly RegroupItem[], gap = TAG_GAP): [string, string] | null {
  const keys = groupKeys(items);
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const A = items[a];
      const B = items[b];
      if (keys.get(A.id) === keys.get(B.id)) continue;
      const ox = (A.w + B.w) / 2 + gap - Math.abs(A.x + A.w / 2 - (B.x + B.w / 2));
      const oy = (A.h + B.h) / 2 + gap - Math.abs(A.y + A.h / 2 - (B.y + B.h / 2));
      // 1px는 부동소수 오차로 남을 수 있다 — 눈에 보이는 겹침만 잡는다.
      if (ox > 1 && oy > 1) return [A.id, B.id];
    }
  }
  return null;
}

describe("이미 나뉘어 있으면 움직이지 않는다", () => {
  it("멀리 떨어진 두 태그는 그대로 둔다", () => {
    const items = [
      item({ id: "a", tag: "가", x: 0, y: 0 }),
      item({ id: "b", tag: "나", x: 900, y: 0 }),
    ];
    expect(regroup(items).moves.size).toBe(0);
  });

  it("무리가 하나뿐이면 할 일이 없다", () => {
    const items = [
      item({ id: "a", tag: "가", x: 0, y: 0 }),
      item({ id: "b", tag: "가", x: 0, y: 300 }),
    ];
    expect(regroup(items).moves.size).toBe(0);
  });
});

describe("겹친 태그는 갈라 놓는다", () => {
  it("정확히 포개진 두 태그가 떨어진다", () => {
    const items = [
      item({ id: "a", tag: "가", x: 0, y: 0 }),
      item({ id: "b", tag: "나", x: 0, y: 0 }),
    ];
    const r = regroup(items);
    expect(r.moves.size).toBe(2);
    expect(tooClose(applied(items, r.moves))).toBeNull();
  });

  it("여러 무리가 뒤엉켜도 전부 갈라진다", () => {
    const items = [
      item({ id: "a1", tag: "가", x: 0, y: 0 }),
      item({ id: "a2", tag: "가", x: 20, y: 140 }),
      item({ id: "b1", tag: "나", x: 60, y: 40 }),
      item({ id: "b2", tag: "나", x: 80, y: 180 }),
      item({ id: "c1", tag: "다", x: 120, y: 90 }),
    ];
    const r = regroup(items);
    expect(tooClose(applied(items, r.moves))).toBeNull();
  });

  it("겹치지 않아도 너무 가까우면 벌린다 — 구분이 목적이다", () => {
    const items = [
      item({ id: "a", tag: "가", x: 0, y: 0, w: 200, h: 100 }),
      item({ id: "b", tag: "나", x: 210, y: 0, w: 200, h: 100 }), // 10px 틈
    ];
    const r = regroup(items);
    expect(r.moves.size).toBe(2);
    expect(tooClose(applied(items, r.moves))).toBeNull();
  });
});

describe("무리 안의 모양은 지킨다", () => {
  it("같은 태그는 통째로 같은 양만큼 움직인다", () => {
    const items = [
      item({ id: "a1", tag: "가", x: 0, y: 0 }),
      item({ id: "a2", tag: "가", x: 40, y: 130 }),
      item({ id: "b1", tag: "나", x: 30, y: 20 }),
    ];
    const { moves } = regroup(items);
    const d1 = moves.get("a1")!;
    const d2 = moves.get("a2")!;
    expect(d1.x - items[0].x).toBeCloseTo(d2.x - items[1].x, 6);
    expect(d1.y - items[0].y).toBeCloseTo(d2.y - items[1].y, 6);
  });

  it("부모가 있는 글은 태그가 없어도 부모 무리에 붙는다", () => {
    const items = [
      item({ id: "q", tag: null, x: 0, y: 0 }),
      item({ id: "ans", tag: null, parentItemId: "q", x: 300, y: 0 }),
      item({ id: "z", tag: "가", x: 10, y: 10 }),
    ];
    const keys = groupKeys(items);
    expect(keys.get("ans")).toBe(keys.get("q"));
    const { moves } = regroup(items);
    // 함께 움직이므로 질문–답 간격은 그대로다(연결선이 늘어나지 않는다).
    const q = moves.get("q") ?? { x: 0, y: 0 };
    const a = moves.get("ans") ?? { x: 300, y: 0 };
    expect(a.x - q.x).toBeCloseTo(300, 6);
    expect(a.y - q.y).toBeCloseTo(0, 6);
  });

  it("태그도 부모도 없는 메모는 각자 한 무리다 — 통째로 끌려다니지 않는다", () => {
    const items = [
      item({ id: "n1", x: 0, y: 0 }),
      item({ id: "n2", x: 2000, y: 2000 }),
    ];
    const keys = groupKeys(items);
    expect(keys.get("n1")).not.toBe(keys.get("n2"));
    expect(regroup(items).moves.size).toBe(0); // 서로 머니 그대로
  });
});

describe("최소한으로 움직인다", () => {
  it("덜 파고든 축으로 민다 — 옆으로 조금 겹쳤으면 옆으로 뺀다", () => {
    // x로는 40px, y로는 260px 파고들었다 → x로 빼는 것이 최소다.
    const items = [
      item({ id: "a", tag: "가", x: 0, y: 0, w: 200, h: 400 }),
      item({ id: "b", tag: "나", x: 160, y: 0, w: 200, h: 400 }),
    ];
    const r = regroup(items);
    const out = applied(items, r.moves);
    expect(tooClose(out)).toBeNull();
    // 세로로는 거의 안 움직였어야 한다.
    for (const o of out) expect(Math.abs(o.y - 0)).toBeLessThan(1);
  });

  it("글이 적은 무리가 더 많이 움직인다", () => {
    const items = [
      item({ id: "a1", tag: "가", x: 0, y: 0 }),
      item({ id: "a2", tag: "가", x: 0, y: 150 }),
      item({ id: "a3", tag: "가", x: 0, y: 300 }),
      item({ id: "b1", tag: "나", x: 40, y: 0 }),
    ];
    const { moves } = regroup(items);
    // 어느 축으로 밀지는 알고리즘이 정한다 — 이동 **거리**로 본다.
    const moved = (id: string, x: number, y: number) => {
      const m = moves.get(id);
      return m ? Math.hypot(m.x - x, m.y - y) : 0;
    };
    expect(moved("b1", 40, 0)).toBeGreaterThan(moved("a1", 0, 0));
  });

  it("전체가 한쪽으로 흐르지 않는다 — 가중 평균 이동이 0이다", () => {
    const items = [
      item({ id: "a", tag: "가", x: 0, y: 0 }),
      item({ id: "b", tag: "나", x: 30, y: 0 }),
      item({ id: "c", tag: "다", x: 60, y: 0 }),
    ];
    const { moves } = regroup(items);
    let sx = 0;
    let sy = 0;
    for (const it of items) {
      const m = moves.get(it.id);
      if (!m) continue;
      sx += m.x - it.x;
      sy += m.y - it.y;
    }
    expect(Math.abs(sx / items.length)).toBeLessThan(1);
    expect(Math.abs(sy / items.length)).toBeLessThan(1);
  });
});

describe("무작위 캔버스에서도 갈라진다", () => {
  it("100케이스 — 남은 겹침이 없다", () => {
    // 결정론적 난수(테스트가 흔들리면 신호가 아니라 소음이다).
    let seed = 20260801;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let c = 0; c < 100; c++) {
      const n = 3 + Math.floor(rnd() * 10);
      const tags = ["가", "나", "다", "라"];
      const items: RegroupItem[] = [];
      for (let i = 0; i < n; i++) {
        items.push(
          item({
            id: `i${i}`,
            tag: tags[Math.floor(rnd() * tags.length)],
            x: Math.round(rnd() * 1200),
            y: Math.round(rnd() * 900),
            w: 132 + Math.round(rnd() * 328),
            h: 26 + Math.round(rnd() * 300),
          }),
        );
      }
      const r = regroup(items);
      expect(tooClose(applied(items, r.moves))).toBeNull();
    }
  });
});
