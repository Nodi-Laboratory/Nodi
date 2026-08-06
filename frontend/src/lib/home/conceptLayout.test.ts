import { describe, expect, it } from "vitest";
import type { ConceptEdge, ConceptNode } from "@/lib/api/conceptMap";
import {
  clusterLabels,
  degrees,
  boundsOf,
  hash01,
  pickSpacedLabels,
  seedPositions,
  tagHue,
  tierFor,
  type LabelBox,
} from "./conceptLayout";

/**
 * 개념 지도의 순수 계산 (D189).
 *
 * 지도가 틀렸는지는 **눈으로 잘 안 보인다** — 그럴싸한 점 구름은 언제나 그럴싸해
 * 보인다. 여기서 고정하는 것은 눈으로 못 잡는 것들이다: 재현성과 무리 이름.
 */

function node(id: string, tag: string | null = null): ConceptNode {
  return {
    id,
    session_id: "s1",
    title: id,
    preview: "",
    tag,
    created_at: "2026-08-06T00:00:00Z",
  };
}

describe("hash01", () => {
  it("같은 입력은 언제나 같은 값", () => {
    expect(hash01("광합성")).toBe(hash01("광합성"));
  });

  it("0..1 안에 있다", () => {
    for (const s of ["", "a", "광합성", "매우 긴 태그 이름".repeat(20)]) {
      const v = hash01(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("다른 입력은 대체로 다른 값", () => {
    const seen = new Set(
      ["광합성", "지구과학", "수학", "국어", "물리", "화학"].map(hash01),
    );
    expect(seen.size).toBe(6);
  });
});

describe("seedPositions", () => {
  it("같은 입력이면 같은 자리 — 새로고침해도 지도가 그대로다", () => {
    const ns = [node("a"), node("b"), node("c")];
    expect(seedPositions(ns, 100)).toEqual(seedPositions(ns, 100));
  });

  it("카드가 하나 늘어도 **앞 카드들의 자리가 안 변한다**", () => {
    // 이게 깨지면 대화 한 번 할 때마다 지도 전체가 다시 배치된다 —
    // 학생 눈에는 매번 새 그림이라 "지도"가 아니게 된다.
    const before = seedPositions([node("a"), node("b")], 100);
    const after = seedPositions([node("a"), node("b"), node("c")], 100);
    // 반지름은 전체 개수에 따라 늘지만 **순서와 방향**은 보존된다.
    for (let i = 0; i < before.length; i++) {
      const angBefore = Math.atan2(before[i].y, before[i].x);
      const angAfter = Math.atan2(after[i].y, after[i].x);
      expect(angAfter).toBeCloseTo(angBefore, 10);
    }
  });

  it("서로 겹치지 않는다 — 겹치면 d3가 난수로 흔들어 재현성이 깨진다", () => {
    const placed = seedPositions(
      Array.from({ length: 50 }, (_, i) => node(`n${i}`)),
      300,
    );
    const seen = new Set(placed.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));
    expect(seen.size).toBe(50);
  });

  it("빈 목록도 죽지 않는다", () => {
    expect(seedPositions([], 100)).toEqual([]);
  });
});

describe("degrees", () => {
  it("선이 없는 노드도 0으로 들어 있다", () => {
    const d = degrees([node("a"), node("b")], []);
    expect(d.get("a")).toBe(0);
    expect(d.get("b")).toBe(0);
  });

  it("양 끝을 다 센다", () => {
    const edges: ConceptEdge[] = [{ a: "a", b: "b", distance: 0.4 }];
    const d = degrees([node("a"), node("b")], edges);
    expect(d.get("a")).toBe(1);
    expect(d.get("b")).toBe(1);
  });

  it("노드 목록에 없는 끝은 세지 않는다", () => {
    // Qdrant가 준 쌍에 RLS로 걸러진 카드가 섞일 수 있다.
    const d = degrees([node("a")], [{ a: "a", b: "남의카드", distance: 0.4 }]);
    expect(d.get("a")).toBe(1);
    expect(d.has("남의카드")).toBe(false);
  });
});

describe("clusterLabels", () => {
  const placed = [
    { ...node("1", "광합성"), x: 0, y: 0, degree: 0 },
    { ...node("2", "광합성"), x: 10, y: 20, degree: 0 },
    { ...node("3", "지구과학"), x: 100, y: 100, degree: 0 },
    { ...node("4", null), x: 500, y: 500, degree: 0 },
  ];

  it("태그마다 무게중심을 낸다", () => {
    const [first] = clusterLabels(placed, 1);
    expect(first.tag).toBe("광합성");
    expect(first.x).toBe(5);
    expect(first.y).toBe(10);
    expect(first.count).toBe(2);
  });

  it("태그 없는 카드는 이름이 없다", () => {
    expect(clusterLabels(placed, 1).map((c) => c.tag)).not.toContain("");
    expect(clusterLabels(placed, 1)).toHaveLength(2);
  });

  it("혼자인 태그는 기본적으로 이름을 안 단다", () => {
    // 낱개마다 이름이 뜨면 축소 화면이 글자로 뒤덮인다.
    expect(clusterLabels(placed).map((c) => c.tag)).toEqual(["광합성"]);
  });

  it("큰 무리가 먼저 — 겹칠 때 위에 오게", () => {
    const many = [
      ...placed,
      { ...node("5", "지구과학"), x: 110, y: 110, degree: 0 },
      { ...node("6", "지구과학"), x: 120, y: 120, degree: 0 },
    ];
    expect(clusterLabels(many)[0].tag).toBe("지구과학");
  });
});

describe("tagHue", () => {
  it("같은 태그는 같은 색", () => {
    expect(tagHue("광합성")).toBe(tagHue("광합성"));
  });

  it("태그가 늘어도 색이 돌려쓰기되지 않는다", () => {
    // 고정 팔레트를 배열로 돌리면 서로 다른 과목이 같은 색을 갖는다.
    const tags = Array.from({ length: 40 }, (_, i) => `태그${i}`);
    expect(new Set(tags.map(tagHue)).size).toBeGreaterThan(30);
  });
});

describe("tierFor", () => {
  it("멀면 이름, 가까우면 낱개, 더 가까우면 제목", () => {
    expect(tierFor(0.3)).toBe("clusters");
    expect(tierFor(1)).toBe("nodes");
    expect(tierFor(3)).toBe("titles");
  });

  it("경계가 겹치지 않는다", () => {
    // 같은 배율에서 두 층이 동시에 참이면 축소 화면이 글자로 덮인다.
    const tiers = [0.54, 0.55, 1.59, 1.6].map(tierFor);
    expect(tiers).toEqual(["clusters", "nodes", "nodes", "titles"]);
  });
});

describe("pickSpacedLabels", () => {
  const box = (x: number, y: number, w = 60, h = 16) => ({ x, y, w, h });

  it("겹치는 이름은 뺀다", () => {
    const items = [box(0, 0), box(10, 0), box(400, 0)];
    expect(pickSpacedLabels(items, (i) => i)).toHaveLength(2);
  });

  it("**넓은 글자**가 옆 것을 덮는 것도 막는다", () => {
    // 격자로만 재던 시절 이걸 못 잡았다 — "빛의 굴절과 분산"이 옆 이름과
    // 겹쳐 둘 다 못 읽었다(실측 2026-08-06).
    const wide = box(0, 0, 200, 16);
    const near = box(90, 0, 60, 16); // 칸은 다르지만 사각형은 겹친다
    expect(pickSpacedLabels([wide, near], (i) => i)).toHaveLength(1);
  });

  it("앞에 있는 것이 자리를 잡는다 — 순서가 곧 우선순위다", () => {
    const big = { ...box(0, 0), name: "큰무리" };
    const small = { ...box(10, 0), name: "작은무리" };
    expect(pickSpacedLabels([big, small], (i) => i)[0].name).toBe("큰무리");
    expect(pickSpacedLabels([small, big], (i) => i)[0].name).toBe("작은무리");
  });

  it("떨어져 있으면 전부 남는다", () => {
    const items = [box(0, 0), box(300, 0), box(0, 200), box(300, 200)];
    expect(pickSpacedLabels(items, (i) => i)).toHaveLength(4);
  });

  it("빈 목록도 죽지 않는다", () => {
    expect(pickSpacedLabels([], (i) => i as LabelBox)).toEqual([]);
  });
});

describe("boundsOf", () => {
  it("전부를 담는 사각형", () => {
    const b = boundsOf([{ x: -10, y: 5 }, { x: 30, y: -5 }, { x: 0, y: 0 }]);
    expect(b).toEqual({ x: -10, y: -5, w: 40, h: 10 });
  });

  it("점 하나여도 폭이 0이 아니다 — 0으로 나누는 자리가 생긴다", () => {
    const b = boundsOf([{ x: 3, y: 3 }])!;
    expect(b.w).toBeGreaterThan(0);
    expect(b.h).toBeGreaterThan(0);
  });

  it("비었으면 null — 호출부가 '맞출 것이 없다'를 알아야 한다", () => {
    expect(boundsOf([])).toBeNull();
  });
});
