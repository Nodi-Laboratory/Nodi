/**
 * 배치 엔진 (D123) — 이 작업에서 가장 중요한 테스트.
 *
 * v1의 d3-force는 무겹침을 **보장하지 못했다.** collide가 원형이고 alphaMin
 * 0.02로 일찍 멈추므로, 수렴 전에 정지하면 겹친 채로 남는다. v2는 무겹침이
 * 알고리즘의 성질이라 그걸 테스트로 못 박는다 — 이 파일이 깨지면 학생 화면에
 * 글자가 겹쳐 보인다는 뜻이다.
 */

import { describe, expect, it } from "vitest";
import {
  COL_GAP,
  ITEM_MIN_W,
  ITEM_W,
  layoutItems,
  placeBesideParent,
  rectOf,
  UNTAGGED,
  type LayoutInput,
} from "./layout";
import { intersects, type Rect } from "./rect";

function item(over: Partial<LayoutInput> & { id: string }): LayoutInput {
  return {
    tag: null,
    seq: 0,
    height: 200,
    // 폭도 실측값이다(내용이 짧으면 좁아진다). 기본은 최대 폭.
    width: ITEM_W,
    pinned: false,
    x: 0,
    y: 0,
    parentItemId: null,
    ...over,
  };
}

/** 배치 결과의 모든 사각형 쌍을 검사한다. */
function overlaps(items: readonly LayoutInput[], obstacles: readonly Rect[] = []) {
  const { positions } = layoutItems(items, obstacles);
  const rects = items.map((i) => ({
    id: i.id,
    r: rectOf(positions.get(i.id)!, { w: i.width, h: i.height }),
  }));
  const bad: string[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (intersects(rects[i].r, rects[j].r)) {
        bad.push(`${rects[i].id}↔${rects[j].id}`);
      }
    }
    for (const o of obstacles) {
      if (intersects(rects[i].r, o)) bad.push(`${rects[i].id}↔장애물`);
    }
  }
  return { bad, positions, rects };
}

// --- 불변식 1: 무겹침 -------------------------------------------------------

describe("무겹침", () => {
  it("같은 태그 여러 개가 겹치지 않는다", () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      item({ id: `a${i}`, tag: "광합성", seq: i, height: 120 + i * 90 }),
    );
    expect(overlaps(items).bad).toEqual([]);
  });

  it("여러 태그가 섞여도 겹치지 않는다", () => {
    const tags = ["광합성", "세포호흡", "물질대사", null];
    const items = Array.from({ length: 24 }, (_, i) =>
      item({ id: `a${i}`, tag: tags[i % 4], seq: i, height: 80 + (i % 7) * 160 }),
    );
    expect(overlaps(items).bad).toEqual([]);
  });

  it("무작위 200케이스에서 한 번도 겹치지 않는다", () => {
    // 결정론적 의사난수 — 실패를 재현할 수 있어야 한다.
    let s = 1234567;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);

    for (let c = 0; c < 200; c++) {
      const n = 1 + Math.floor(rnd() * 14);
      const tagPool = ["가", "나", "다", "라", null];
      const items = Array.from({ length: n }, (_, i) =>
        item({
          id: `i${i}`,
          tag: tagPool[Math.floor(rnd() * tagPool.length)],
          seq: i,
          height: 50 + Math.floor(rnd() * 1950),
          // 폭이 제각각이어도 겹치면 안 된다. 폭 고정이던 시절에는 이 축이
          // 아예 없었다 — 폭을 내용에 맡긴 뒤로는 여기가 실제 위험 지점이다.
          width: ITEM_MIN_W + Math.floor(rnd() * (ITEM_W - ITEM_MIN_W)),
          pinned: rnd() < 0.25,
          x: Math.floor(rnd() * 2000) - 500,
          y: Math.floor(rnd() * 2000) - 500,
        }),
      );
      const obstacles: Rect[] = Array.from(
        { length: Math.floor(rnd() * 4) },
        () => ({
          x: Math.floor(rnd() * 1600) - 300,
          y: Math.floor(rnd() * 1600) - 300,
          w: 60 + Math.floor(rnd() * 500),
          h: 60 + Math.floor(rnd() * 500),
        }),
      );

      // pinned끼리는 서로 겹칠 수 있다(학생이 그렇게 뒀으면 그게 맞다).
      // 자동 배치 아이템이 무엇과도 안 겹치는지만 본다.
      const { positions } = layoutItems(items, obstacles);
      const auto = items.filter((i) => !i.pinned);
      const all = items.map((i) => ({ i, r: rectOf(positions.get(i.id)!, { w: i.width, h: i.height }) }));
      for (const a of auto) {
        const ar = rectOf(positions.get(a.id)!, { w: a.width, h: a.height });
        for (const other of all) {
          if (other.i.id === a.id) continue;
          expect(
            intersects(ar, other.r),
            `케이스 ${c}: ${a.id} ↔ ${other.i.id}`,
          ).toBe(false);
        }
        for (const o of obstacles) {
          expect(intersects(ar, o), `케이스 ${c}: ${a.id} ↔ 장애물`).toBe(false);
        }
      }
    }
  });

  it("장애물이 열을 완전히 덮어도 종료하고 그 아래에 놓는다", () => {
    const items = [item({ id: "a", tag: "가", height: 100 })];
    const wall: Rect = { x: -5000, y: -5000, w: 10000, h: 10000 };
    const { positions } = layoutItems(items, [wall]);
    const p = positions.get("a")!;
    expect(p.y).toBeGreaterThanOrEqual(5000);
    expect(intersects(rectOf(p, { w: ITEM_W, h: 100 }), wall)).toBe(false);
  });
});

// --- 불변식 2: 결정론 -------------------------------------------------------

describe("결정론", () => {
  it("같은 입력 → 같은 출력", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item({ id: `a${i}`, tag: ["가", "나"][i % 2], seq: i, height: 100 + i * 40 }),
    );
    const a = layoutItems(items);
    const b = layoutItems(items);
    expect([...b.positions]).toEqual([...a.positions]);
    expect(b.tagOrder).toEqual(a.tagOrder);
  });

  it("입력 순서가 섞여도 seq가 같으면 같은 배치", () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      item({ id: `a${i}`, tag: ["가", "나", "다"][i % 3], seq: i, height: 150 }),
    );
    const shuffled = [...items].reverse();
    expect([...layoutItems(shuffled).positions]).toEqual(
      [...layoutItems(items).positions],
    );
  });
});

// --- 불변식 3: pinned은 움직이지 않는다 --------------------------------------

describe("pinned", () => {
  it("학생이 정한 자리를 그대로 쓴다", () => {
    const items = [
      item({ id: "p", tag: "가", pinned: true, x: 777, y: -123, height: 300 }),
      item({ id: "a", tag: "가", seq: 1, height: 200 }),
    ];
    const { positions } = layoutItems(items);
    expect(positions.get("p")).toEqual({ x: 777, y: -123 });
  });

  it("pinned은 자동 배치의 장애물이 된다", () => {
    // 열 0의 맨 위를 pinned가 차지하면 자동 아이템은 그 아래로 간다.
    const items = [
      item({ id: "p", tag: "가", pinned: true, x: 0, y: 0, height: 400 }),
      item({ id: "a", tag: "가", seq: 1, height: 200 }),
    ];
    const { positions } = layoutItems(items);
    expect(positions.get("a")!.y).toBeGreaterThanOrEqual(400);
    expect(overlaps(items).bad).toEqual([]);
  });
});

// --- 불변식 4: 열 구조 ------------------------------------------------------

describe("태그 열", () => {
  it("첫 등장 순서로 열이 정해진다", () => {
    const items = [
      item({ id: "a", tag: "나중", seq: 5 }),
      item({ id: "b", tag: "먼저", seq: 1 }),
    ];
    const { columnX, tagOrder } = layoutItems(items);
    expect(tagOrder).toEqual(["먼저", "나중"]);
    expect(columnX.get("먼저")).toBe(0);
    expect(columnX.get("나중")).toBe(ITEM_W + COL_GAP);
  });

  it("이전 순서를 이어받아 열이 움직이지 않는다", () => {
    const first = layoutItems([item({ id: "a", tag: "가" })]);
    const second = layoutItems(
      [item({ id: "a", tag: "가" }), item({ id: "b", tag: "나", seq: 1 })],
      [],
      first.tagOrder,
    );
    expect(second.columnX.get("가")).toBe(first.columnX.get("가"));
  });

  it("태그가 나중에 추가돼도 기존 열 x가 그대로다", () => {
    const base = layoutItems([
      item({ id: "a", tag: "가" }),
      item({ id: "b", tag: "나", seq: 1 }),
    ]);
    const next = layoutItems(
      [
        item({ id: "a", tag: "가" }),
        item({ id: "b", tag: "나", seq: 1 }),
        item({ id: "c", tag: "다", seq: 2 }),
      ],
      [],
      base.tagOrder,
    );
    expect(next.columnX.get("가")).toBe(base.columnX.get("가"));
    expect(next.columnX.get("나")).toBe(base.columnX.get("나"));
  });

  it("같은 열에서 seq 순서가 y 순서와 같다", () => {
    const items = [3, 1, 2, 0].map((seq) =>
      item({ id: `s${seq}`, tag: "가", seq, height: 100 + seq * 50 }),
    );
    const { positions } = layoutItems(items);
    const ys = [0, 1, 2, 3].map((s) => positions.get(`s${s}`)!.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it("태그 없는 아이템은 전용 열로 모인다", () => {
    const items = [
      item({ id: "a", tag: null }),
      item({ id: "b", tag: null, seq: 1 }),
    ];
    const { positions, tagOrder } = layoutItems(items);
    expect(tagOrder).toContain(UNTAGGED);
    expect(positions.get("a")!.x).toBe(positions.get("b")!.x);
  });
});

// --- 불변식 5: 자식 배치 ----------------------------------------------------

describe("AI 응답을 메모 옆에", () => {
  it("부모 오른쪽에 놓인다", () => {
    const items = [
      item({ id: "note", tag: null, pinned: true, x: 100, y: 100, height: 150 }),
      item({ id: "ans", seq: 1, parentItemId: "note", height: 300 }),
    ];
    const { positions } = layoutItems(items);
    const ans = positions.get("ans")!;
    expect(ans.x).toBeGreaterThan(100 + ITEM_W);
    expect(overlaps(items).bad).toEqual([]);
  });

  it("부모가 사라지면 열 흐름으로 떨어진다(화면에서 없어지지 않는다)", () => {
    const items = [item({ id: "ans", parentItemId: "없는부모", height: 200 })];
    const { positions } = layoutItems(items);
    expect(positions.get("ans")).toBeDefined();
  });

  it("오른쪽이 막히면 아래로 밀린다", () => {
    const parent: Rect = { x: 0, y: 0, w: ITEM_W, h: 200 };
    const blocker: Rect = { x: ITEM_W, y: -1000, w: 2000, h: 1400 };
    const spot = placeBesideParent(parent, ITEM_W, 200, [blocker]);
    expect(intersects({ ...spot, w: ITEM_W, h: 200 }, blocker)).toBe(false);
    expect(spot.y).toBeGreaterThan(0);
  });
});

// --- 경계 --------------------------------------------------------------------

describe("경계", () => {
  it("아이템이 없어도 죽지 않는다", () => {
    const r = layoutItems([]);
    expect(r.positions.size).toBe(0);
    expect(r.tagOrder).toEqual([]);
  });

  it("높이 0도 처리한다", () => {
    const { positions } = layoutItems([item({ id: "a", height: 0 })]);
    expect(positions.get("a")).toBeDefined();
  });

  it("아이템 60개에서도 겹치지 않는다", () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      item({ id: `a${i}`, tag: `t${i % 6}`, seq: i, height: 100 + (i % 11) * 120 }),
    );
    expect(overlaps(items).bad).toEqual([]);
  });
});

// --- 트리 배치 (D151) ----------------------------------------------------

/** 트리에 들어가는 AI 개념 카드. */
function card(
  id: string,
  tag: string,
  parentItemId: string | null,
  seq: number,
): LayoutInput {
  return item({ id, tag, parentItemId, seq, kind: "concept", source: "ai" });
}

describe("트리 배치 (D151)", () => {
  it("곧게 이어지는 대화는 들여쓰지 않는다", () => {
    const items = [
      card("a", "물리", null, 0),
      card("b", "물리", "a", 1),
      card("c", "물리", "b", 2),
    ];
    const { positions } = layoutItems(items);
    const xs = items.map((i) => positions.get(i.id)!.x);
    expect(new Set(xs).size).toBe(1); // 한 줄로 곧게
    // 순서도 유지된다
    const ys = items.map((i) => positions.get(i.id)!.y);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
  });

  it("형제는 좌우로 나란히, 부모는 그 위 가운데 (D159 tidy tree)", () => {
    const items = [
      card("r", "물리", null, 0),
      card("c1", "물리", "r", 1),
      card("c2", "물리", "r", 2),
    ];
    const { positions } = layoutItems(items);
    const p = (id: string) => positions.get(id)!;
    // 형제는 같은 높이에 좌우로
    expect(p("c1").y).toBe(p("c2").y);
    expect(p("c2").x).toBeGreaterThan(p("c1").x);
    // 부모는 두 자식의 가운데 위
    const mid = (p("c1").x + p("c2").x + ITEM_W) / 2;
    expect(Math.abs(p("r").x + ITEM_W / 2 - mid)).toBeLessThan(1);
    expect(p("r").y).toBeLessThan(p("c1").y);
  });

  it("자식이 늘면 형제 서브트리가 좌우로 밀려난다", () => {
    const before = layoutItems([
      card("r", "물리", null, 0),
      card("a", "물리", "r", 1),
      card("b", "물리", "r", 2),
    ]).positions;
    // a에 자식을 둘 붙이면 a의 서브트리 폭이 커진다 → b가 오른쪽으로 밀린다
    const after = layoutItems([
      card("r", "물리", null, 0),
      card("a", "물리", "r", 1),
      card("b", "물리", "r", 2),
      card("a1", "물리", "a", 3),
      card("a2", "물리", "a", 4),
    ]).positions;
    expect(after.get("b")!.x - after.get("a")!.x).toBeGreaterThan(
      before.get("b")!.x - before.get("a")!.x,
    );
  });

  it("손자는 자기 부모 아래, 삼촌은 옆 (D159)", () => {
    const items = [
      card("r", "물리", null, 0),
      card("c1", "물리", "r", 1),
      card("c2", "물리", "r", 2),
      card("g1", "물리", "c1", 3),
    ];
    const { positions } = layoutItems(items);
    const p = (id: string) => positions.get(id)!;
    expect(p("g1").y).toBeGreaterThan(p("c1").y); // 부모 아래
    expect(p("c1").y).toBe(p("c2").y); // 형제는 같은 줄
    // 손자는 자기 부모의 띠 안에 머문다 — 삼촌 쪽으로 넘어가지 않는다
    expect(p("g1").x).toBeLessThan(p("c2").x);
  });

  it("넓은 트리라도 옆 열을 침범하지 않는다 (열 x는 누적)", () => {
    const items: LayoutInput[] = [card("r", "물리", null, 0)];
    for (let i = 0; i < 8; i++) items.push(card(`k${i}`, "물리", "r", i + 1));
    items.push(card("other", "생명", null, 100));
    const { positions, columnX } = layoutItems(items);
    const nextCol = columnX.get("생명")!;
    for (const i of items) {
      if (i.tag !== "물리") continue;
      expect(positions.get(i.id)!.x + i.width).toBeLessThanOrEqual(nextCol);
    }
  });

  it("트리가 있어도 겹치지 않는다", () => {
    const items = [
      card("r", "물리", null, 0),
      card("c1", "물리", "r", 1),
      card("c2", "물리", "r", 2),
      card("g1", "물리", "c1", 3),
      card("s", "생명", null, 4),
      item({ id: "memo", tag: "물리", seq: 5, source: "user", kind: "note" }),
    ];
    expect(overlaps(items).bad).toEqual([]);
  });
});

describe("자식은 부모보다 위에 놓이지 않는다 (사용자 지시 2026-08-02)", () => {
  it("부모가 저 아래에 고정돼 있어도 자식은 그 아래다", () => {
    const items = [
      card("r", "물리", null, 0),
      // 학생이 부모를 한참 아래로 끌어다 놓았다
      { ...card("p", "물리", "r", 1), pinned: true, x: 0, y: 3000 },
      card("c", "물리", "p", 2),
    ];
    const { positions } = layoutItems(items);
    expect(positions.get("c")!.y).toBeGreaterThanOrEqual(positions.get("p")!.y);
  });

  it("고정된 노드 뒤의 형제도 그 위로 올라가지 않는다", () => {
    const items = [
      { ...card("a", "물리", null, 0), pinned: true, x: 0, y: 2000 },
      card("b", "물리", "a", 1),
      card("c", "물리", "b", 2),
    ];
    const { positions } = layoutItems(items);
    expect(positions.get("b")!.y).toBeGreaterThanOrEqual(2000);
    expect(positions.get("c")!.y).toBeGreaterThanOrEqual(positions.get("b")!.y);
  });

  it("모든 트리 간선에서 자식 y ≥ 부모 y (무작위 60케이스)", () => {
    for (let seed = 0; seed < 60; seed++) {
      const items: LayoutInput[] = [];
      let prev: string | null = null;
      for (let i = 0; i < 12; i++) {
        const id = `n${i}`;
        // 3의 배수마다 뿌리로 갈라지고, 5의 배수마다 고정된다
        const parent = i % 3 === 0 ? null : prev;
        const c = card(id, "물리", parent, i);
        items.push(
          (seed + i) % 5 === 0
            ? { ...c, pinned: true, x: 0, y: ((seed * 37 + i * 91) % 20) * 120 }
            : c,
        );
        prev = id;
      }
      const { positions } = layoutItems(items);
      for (const it of items) {
        if (!it.parentItemId || it.pinned) continue;
        const p = positions.get(it.parentItemId);
        const c = positions.get(it.id);
        if (!p || !c) continue;
        expect(c.y).toBeGreaterThanOrEqual(p.y);
      }
      // 자동 배치된 것끼리는 절대 겹치지 않는다. 고정된 카드는 학생이 손으로
      // 끌어다 둔 자리라 보장 대상이 아니다 — 엔진이 학생의 결정을 밀어낼 수는
      // 없다(D159).
      expect(overlaps(items.filter((i) => !i.pinned)).bad).toEqual([]);
    }
  });
});
