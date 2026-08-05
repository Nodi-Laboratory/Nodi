import { describe, expect, it } from "vitest";
import {
  descendants,
  assignParents,
  buildTrees,
  headOf,
  isTreeNode,
  nextFocus,
  treeEdges,
  LOOSE_TAG,
  type TreeItem,
} from "./tree";
import { UNTAGGED } from "./layout";

let seq = 0;
function node(
  id: string,
  tag: string | null,
  parentItemId: string | null = null,
  over: Partial<TreeItem> = {},
): TreeItem {
  return {
    id,
    tag,
    parentItemId,
    seq: seq++,
    kind: "concept",
    source: "ai",
    ...over,
  };
}

describe("isTreeNode", () => {
  it("AI 개념 카드만 트리에 들어간다", () => {
    expect(isTreeNode(node("a", "물리"))).toBe(true);
    expect(isTreeNode(node("b", "물리", null, { source: "user" }))).toBe(false);
    expect(isTreeNode(node("c", "물리", null, { kind: "figure" }))).toBe(false);
  });

  /**
   * **태그가 없어도 노드다** (D180). 예전에는 태그를 요구했는데, 그러면 학생이
   * 떼어낸 가지가 트리에서 통째로 빠져 **가지 안쪽 연결선까지 사라진다** —
   * 낱장으로 흩어지고 "떼어낸 가지에서 또 떼어내기"가 성립하지 않는다.
   */
  it("분류 없는 개념 카드도 노드다", () => {
    expect(isTreeNode(node("d", null))).toBe(true);
  });
});

describe("분류 없는 가지 (D180)", () => {
  it("떼어낸 가지가 모양을 유지한다", () => {
    seq = 0;
    // 학생이 b를 떼어냈다 — b와 그 자손의 태그가 비었다.
    const items = [
      node("a", "물리"),
      node("b", null, "a"),
      node("c", null, "b"),
    ];
    const e = treeEdges(items);
    // a—b는 끊긴다(태그가 다르다). b—c는 **살아 있다**(둘 다 분류 없음).
    expect(e).toEqual([{ from: "b", to: "c", tag: LOOSE_TAG }]);
  });

  it("분류 없는 가지가 자기 트리를 이룬다", () => {
    seq = 0;
    const items = [node("a", "물리"), node("b", null), node("c", null, "b")];
    const trees = buildTrees(items);
    const loose = trees.find((t) => t.tag === LOOSE_TAG)!;
    expect(loose.roots).toEqual(["b"]);
    expect(loose.order).toEqual(["b", "c"]);
    expect(loose.depth.get("c")).toBe(1);
  });

  /**
   * 배치는 열을 `it.tag || UNTAGGED`로 묶는다. 두 상수가 갈리면 무태그 트리가
   * **어느 열에도 안 들어가 화면에서 사라진다.**
   */
  it("배치의 무태그 열 이름과 같은 값이다", () => {
    expect(LOOSE_TAG).toBe(UNTAGGED);
  });
});

describe("treeEdges — 거미줄이 되지 않는다", () => {
  it("부모가 있는 만큼만 간선이 생긴다", () => {
    seq = 0;
    const items = [node("a", "물리"), node("b", "물리", "a"), node("c", "물리", "b")];
    const e = treeEdges(items);
    expect(e).toEqual([
      { from: "a", to: "b", tag: "물리" },
      { from: "b", to: "c", tag: "물리" },
    ]);
    // 노드 3, 트리 1 → 간선 2
    expect(e.length).toBe(items.length - 1);
  });

  it("태그가 다르면 잇지 않는다 (학생이 분류를 바꾼 경우)", () => {
    seq = 0;
    const items = [node("a", "물리"), node("b", "화학", "a")];
    expect(treeEdges(items)).toEqual([]);
  });

  it("부모가 사라졌으면 잇지 않는다", () => {
    seq = 0;
    expect(treeEdges([node("b", "물리", "없는-id")])).toEqual([]);
  });

  it("학생 메모는 트리에 끼지 않는다", () => {
    seq = 0;
    const memo = node("m", "물리", null, { source: "user", kind: "note" });
    const items = [memo, node("a", "물리", "m")];
    expect(treeEdges(items)).toEqual([]);
  });
});

describe("buildTrees", () => {
  it("태그마다 트리 하나, 태그 순서는 첫 등장 순서", () => {
    seq = 0;
    const items = [
      node("a", "물리"),
      node("x", "생명"),
      node("b", "물리", "a"),
    ];
    const trees = buildTrees(items);
    expect(trees.map((t) => t.tag)).toEqual(["물리", "생명"]);
    expect(trees[0].order).toEqual(["a", "b"]);
    expect(trees[0].depth.get("b")).toBe(1);
    expect(trees[1].roots).toEqual(["x"]);
  });

  it("분기가 있으면 깊이 우선으로 편다(형제는 생성 순서)", () => {
    seq = 0;
    const items = [
      node("r", "물리"),
      node("c1", "물리", "r"),
      node("c2", "물리", "r"),
      node("g1", "물리", "c1"),
    ];
    const t = buildTrees(items)[0];
    expect(t.order).toEqual(["r", "c1", "g1", "c2"]);
    expect([...t.depth.values()]).toEqual([0, 1, 2, 1]);
  });

  it("순환이 있어도 멈추지 않는다", () => {
    seq = 0;
    const a = node("a", "물리", "b");
    const b = node("b", "물리", "a");
    const t = buildTrees([a, b])[0];
    // 둘 다 부모가 있어 뿌리가 없다 — 간선만 있고 순회는 비어도 멈추면 안 된다.
    expect(t.order.length).toBeLessThanOrEqual(2);
  });
});

describe("headOf — 다음 카드가 붙을 자리", () => {
  it("고른 노드가 이 태그면 그 자리", () => {
    seq = 0;
    const items = [node("a", "물리"), node("b", "물리", "a")];
    expect(headOf(items, "물리", "a")).toBe("a");
  });

  it("고른 노드가 다른 태그면 마지막 카드", () => {
    seq = 0;
    const items = [node("a", "물리"), node("b", "물리", "a"), node("x", "생명")];
    expect(headOf(items, "물리", "x")).toBe("b");
  });

  it("고른 것이 없으면 마지막 카드", () => {
    seq = 0;
    const items = [node("a", "물리"), node("b", "물리", "a")];
    expect(headOf(items, "물리", null)).toBe("b");
  });

  it("처음 보는 태그면 없다", () => {
    seq = 0;
    expect(headOf([node("a", "물리")], "화학", null)).toBeNull();
  });
});

describe("assignParents — 사용자가 정한 규칙 그대로", () => {
  it("새 태그는 뿌리가 된다", () => {
    seq = 0;
    const p = assignParents([], [{ id: "n1", tag: "물리" }], null);
    expect(p.get("n1")).toBeNull();
  });

  it("한 턴의 같은 태그 카드들은 한 줄기로 이어진다", () => {
    seq = 0;
    const p = assignParents(
      [],
      [
        { id: "n1", tag: "물리" },
        { id: "n2", tag: "물리" },
        { id: "n3", tag: "물리" },
      ],
      null,
    );
    expect(p.get("n1")).toBeNull();
    expect(p.get("n2")).toBe("n1");
    expect(p.get("n3")).toBe("n2");
  });

  it("이미 있는 태그면 그 트리의 마지막 뒤에 붙는다", () => {
    seq = 0;
    const existing = [node("a", "물리"), node("b", "물리", "a")];
    const p = assignParents(existing, [{ id: "n1", tag: "물리" }], null);
    expect(p.get("n1")).toBe("b");
  });

  it("노드를 고르고 물으면 거기서 갈라진다", () => {
    seq = 0;
    const existing = [node("a", "물리"), node("b", "물리", "a")];
    const p = assignParents(existing, [{ id: "n1", tag: "물리" }], "a");
    expect(p.get("n1")).toBe("a"); // b가 아니라 a에서 분기
  });

  it("고른 노드와 답의 태그가 다르면 그 태그의 트리를 따른다", () => {
    seq = 0;
    const existing = [node("a", "물리"), node("x", "생명")];
    const p = assignParents(existing, [{ id: "n1", tag: "생명" }], "a");
    expect(p.get("n1")).toBe("x");
  });

  it("한 턴에 태그가 섞여 있으면 각자 자기 트리로 간다", () => {
    seq = 0;
    const existing = [node("a", "물리")];
    const p = assignParents(
      existing,
      [
        { id: "n1", tag: "물리" },
        { id: "n2", tag: "생명" },
        { id: "n3", tag: "물리" },
      ],
      null,
    );
    expect(p.get("n1")).toBe("a");
    expect(p.get("n2")).toBeNull(); // 새 태그 → 뿌리
    expect(p.get("n3")).toBe("n1"); // 같은 턴의 물리 사슬
  });

  it("분류 없는 카드는 트리에 넣지 않는다", () => {
    seq = 0;
    const p = assignParents([], [{ id: "n1", tag: "  " }], null);
    expect(p.get("n1")).toBeNull();
  });

  it("붙인 결과가 실제로 간선이 된다 (규칙과 표시가 어긋나지 않는다)", () => {
    seq = 0;
    const existing = [node("a", "물리")];
    const incoming = [
      { id: "n1", tag: "물리" },
      { id: "n2", tag: "물리" },
    ];
    const p = assignParents(existing, incoming, null);
    const all = [
      ...existing,
      ...incoming.map((c, i) => node(c.id, c.tag, p.get(c.id) ?? null, { seq: 100 + i })),
    ];
    expect(treeEdges(all)).toEqual([
      { from: "a", to: "n1", tag: "물리" },
      { from: "n1", to: "n2", tag: "물리" },
    ]);
    // 트리 하나에 노드 3 → 간선 2. 거미줄이 아니다.
    expect(buildTrees(all)[0].order).toEqual(["a", "n1", "n2"]);
  });
});

describe("nextFocus", () => {
  it("초점이 있던 태그의 새 카드로 옮긴다", () => {
    expect(
      nextFocus("a", "물리", [
        { id: "n1", tag: "물리" },
        { id: "n2", tag: "물리" },
      ]),
    ).toBe("n2");
  });

  it("그 태그의 새 카드가 없으면 그대로 둔다", () => {
    expect(nextFocus("a", "물리", [{ id: "n1", tag: "생명" }])).toBe("a");
  });

  it("초점이 없었으면 만들지 않는다", () => {
    expect(nextFocus(null, null, [{ id: "n1", tag: "물리" }])).toBeNull();
  });
});

describe("descendants — 트리 분리", () => {
  it("딸린 가지를 전부 모은다", () => {
    seq = 0;
    const items = [
      node("r", "물리"),
      node("c1", "물리", "r"),
      node("c2", "물리", "r"),
      node("g1", "물리", "c1"),
      node("x", "생명"),
    ];
    expect(descendants(items, "r").sort()).toEqual(["c1", "c2", "g1"]);
    expect(descendants(items, "c1")).toEqual(["g1"]);
    expect(descendants(items, "g1")).toEqual([]);
  });

  it("태그가 다른 쪽으로는 넘어가지 않는다", () => {
    seq = 0;
    const items = [node("r", "물리"), node("c", "화학", "r")];
    expect(descendants(items, "r")).toEqual([]);
  });

  it("순환이 있어도 멈춘다", () => {
    seq = 0;
    const items = [node("a", "물리", "b"), node("b", "물리", "a")];
    expect(descendants(items, "a").length).toBeLessThanOrEqual(2);
  });
});
