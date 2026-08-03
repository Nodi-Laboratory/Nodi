import { describe, expect, it } from "vitest";
import { branchesOf, navigate } from "./navigate";
import type { TreeItem } from "./tree";

let seq = 0;
function node(
  id: string,
  tag: string | null,
  parentItemId: string | null = null,
  over: Partial<TreeItem> = {},
): TreeItem {
  return { id, tag, parentItemId, seq: seq++, kind: "concept", source: "ai", ...over };
}

/**
 *   [물리]            [생명]        [지구]
 *   r1                 s1            e1
 *   ├ a                └ s2
 *   │ └ a1
 *   └ b
 */
function fixture(): { items: TreeItem[]; order: string[] } {
  seq = 0;
  return {
    items: [
      node("r1", "물리"),
      node("a", "물리", "r1"),
      node("a1", "물리", "a"),
      node("b", "물리", "r1"),
      node("s1", "생명"),
      node("s2", "생명", "s1"),
      node("e1", "지구"),
      node("memo", "물리", null, { kind: "note", source: "user" }),
    ],
    order: ["물리", "생명", "지구"],
  };
}

describe("branchesOf — 아래 버튼이 몇 갈래로 쪼개지나", () => {
  it("자식을 생성 순서로 준다", () => {
    const { items } = fixture();
    expect(branchesOf(items, "r1")).toEqual(["a", "b"]);
    expect(branchesOf(items, "a")).toEqual(["a1"]);
    expect(branchesOf(items, "a1")).toEqual([]);
  });

  it("트리 밖 글은 갈래가 없다", () => {
    const { items } = fixture();
    expect(branchesOf(items, "memo")).toEqual([]);
    expect(branchesOf(items, null)).toEqual([]);
  });

  it("태그가 다른 자식은 세지 않는다", () => {
    seq = 0;
    const items = [node("p", "물리"), node("c", "화학", "p")];
    expect(branchesOf(items, "p")).toEqual([]);
  });
});

describe("navigate — 위아래는 같은 트리 안", () => {
  it("위는 부모로", () => {
    const { items, order } = fixture();
    expect(navigate(items, order, "a1", "up")).toBe("a");
    expect(navigate(items, order, "a", "up")).toBe("r1");
  });

  it("뿌리에서 위로는 갈 곳이 없다", () => {
    const { items, order } = fixture();
    expect(navigate(items, order, "r1", "up")).toBeNull();
  });

  it("아래는 첫 자식으로 (갈라지면 첫 갈래)", () => {
    const { items, order } = fixture();
    expect(navigate(items, order, "r1", "down")).toBe("a");
    expect(navigate(items, order, "a", "down")).toBe("a1");
  });

  it("잎에서 아래로는 갈 곳이 없다", () => {
    const { items, order } = fixture();
    expect(navigate(items, order, "a1", "down")).toBeNull();
    expect(navigate(items, order, "b", "down")).toBeNull();
  });
});

describe("navigate — 좌우는 트리를 옮긴다", () => {
  it("오른쪽 트리의 뿌리로", () => {
    const { items, order } = fixture();
    expect(navigate(items, order, "a1", "right")).toBe("s1");
    expect(navigate(items, order, "s2", "right")).toBe("e1");
  });

  it("왼쪽 트리의 뿌리로", () => {
    const { items, order } = fixture();
    expect(navigate(items, order, "e1", "left")).toBe("s1");
    expect(navigate(items, order, "s1", "left")).toBe("r1");
  });

  it("양끝에서는 넘어가지 않는다", () => {
    const { items, order } = fixture();
    expect(navigate(items, order, "r1", "left")).toBeNull();
    expect(navigate(items, order, "e1", "right")).toBeNull();
  });

  it("열 순서를 따른다 (화면과 눈이 맞아야 한다)", () => {
    const { items } = fixture();
    // 열 순서를 뒤집으면 좌우도 뒤집힌다
    expect(navigate(items, ["지구", "생명", "물리"], "e1", "right")).toBe("s1");
  });
});

describe("navigate — 고른 것이 없을 때", () => {
  it("어느 방향이든 첫 트리의 뿌리로 들어간다", () => {
    const { items, order } = fixture();
    for (const d of ["up", "down", "left", "right"] as const) {
      expect(navigate(items, order, null, d)).toBe("r1");
    }
  });

  it("트리 밖 글을 고르고 있어도 트리로 들어간다", () => {
    const { items, order } = fixture();
    expect(navigate(items, order, "memo", "down")).toBe("r1");
  });

  it("트리가 없으면 아무 데도 못 간다", () => {
    seq = 0;
    const items = [node("m", "물리", null, { kind: "note", source: "user" })];
    expect(navigate(items, ["물리"], null, "down")).toBeNull();
  });
});
