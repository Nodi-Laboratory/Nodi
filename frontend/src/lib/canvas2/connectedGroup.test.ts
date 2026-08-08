/** 이어진 묶음 세기 (D210 6-2). */

import { describe, expect, it } from "vitest";
import { connectedGroup } from "./tree";
import type { TreeItem } from "./tree";

const 카드 = (id: string, seq: number, tag: string | null, parent: string | null): TreeItem => ({
  id,
  seq,
  tag,
  parentItemId: parent,
  kind: "concept",
  source: "ai",
});

describe("이어진 묶음", () => {
  it("혼자면 자기 하나다", () => {
    const items = [카드("a", 1, "판 구조론", null), 카드("b", 2, "판 구조론", null)];
    expect(connectedGroup(items, "a")).toEqual(["a"]);
  });

  it("부모만 있어도 혼자가 아니다 — 아래로만 세면 놓친다", () => {
    const items = [카드("a", 1, "판 구조론", null), 카드("b", 2, "판 구조론", "a")];
    expect(connectedGroup(items, "b").sort()).toEqual(["a", "b"]);
  });

  it("형제도 같은 묶음이다", () => {
    const items = [
      카드("a", 1, "판 구조론", null),
      카드("b", 2, "판 구조론", "a"),
      카드("c", 3, "판 구조론", "a"),
    ];
    expect(connectedGroup(items, "b").sort()).toEqual(["a", "b", "c"]);
  });

  it("태그가 다르면 선이 끊긴 것이라 묶이지 않는다", () => {
    const items = [카드("a", 1, "판 구조론", null), 카드("b", 2, "지진", "a")];
    expect(connectedGroup(items, "b")).toEqual(["b"]);
  });

  it("분류 없는 가지도 묶인다 (D180)", () => {
    const items = [카드("a", 1, null, null), 카드("b", 2, null, "a")];
    expect(connectedGroup(items, "a").sort()).toEqual(["a", "b"]);
  });

  it("학생이 쓴 카드는 노드가 아니라 안 묶인다", () => {
    const items = [
      카드("a", 1, "판 구조론", null),
      { ...카드("b", 2, "판 구조론", "a"), source: "student" as const },
    ];
    expect(connectedGroup(items, "b")).toEqual(["b"]);
  });

  it("순환이 있어도 멈춘다", () => {
    const items = [카드("a", 1, "판 구조론", "b"), 카드("b", 2, "판 구조론", "a")];
    expect(connectedGroup(items, "a").sort()).toEqual(["a", "b"]);
  });
});
