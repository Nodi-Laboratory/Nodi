import { describe, expect, it } from "vitest";
import {
  buildSessionTree,
  folderCheckState,
  folderKey,
  pruneHidden,
  toggleFolder,
  toggleSession,
  UNTITLED_SESSION,
} from "./sessionTree";
import type { ConceptMapSession, ConceptNode } from "@/lib/api/conceptMap";
import type { HomeSpace } from "@/lib/types";

function node(id: string, sessionId: string | null): ConceptNode {
  return {
    id,
    session_id: sessionId,
    title: id,
    preview: "",
    tag: null,
    created_at: "2026-08-06T00:00:00Z",
  };
}

function session(
  id: string,
  over: Partial<ConceptMapSession> = {},
): ConceptMapSession {
  return {
    id,
    title: id,
    space_kind: "personal",
    space_ref: null,
    updated_at: "2026-08-06T00:00:00Z",
    ...over,
  };
}

describe("folderKey", () => {
  it("개인 공간은 ref를 안 본다", () => {
    // 세션의 space_ref가 소유자 id일 때도 null일 때도 있다 — 섞으면 같은
    // 개인 공간이 폴더 둘로 갈린다.
    expect(folderKey("personal", null)).toBe(folderKey("personal", "owner-1"));
  });

  it("학급은 ref마다 다른 폴더다", () => {
    expect(folderKey("class", "c1")).not.toBe(folderKey("class", "c2"));
  });
});

describe("buildSessionTree", () => {
  const spaces: HomeSpace[] = [
    { space_kind: "personal", space_ref: "owner-1", name: "개인 공간", role_in_class: null },
    { space_kind: "class", space_ref: "c1", name: "2학년 3반 지구과학", role_in_class: "student" },
    { space_kind: "class", space_ref: "c2", name: "1학년 5반 과학", role_in_class: "student" },
  ];

  it("공간마다 폴더를 만들고 개념 수를 센다", () => {
    const nodes = [node("n1", "s1"), node("n2", "s1"), node("n3", "s2")];
    const sessions = [
      session("s1"),
      session("s2", { space_kind: "class", space_ref: "c1" }),
    ];
    const tree = buildSessionTree(nodes, sessions, spaces);

    expect(tree.map((f) => f.name)).toEqual(["개인 공간", "2학년 3반 지구과학"]);
    expect(tree[0].sessions[0]).toMatchObject({ id: "s1", count: 2 });
    expect(tree[0].count).toBe(2);
    expect(tree[1].count).toBe(1);
    expect(tree[1].spaceRef).toBe("c1");
  });

  it("개념이 없는 대화와 빈 폴더는 안 낸다", () => {
    // 끄고 켜도 화면이 안 변하는 체크박스는 고장으로 읽힌다.
    const nodes = [node("n1", "s1")];
    const sessions = [
      session("s1"),
      session("s-empty"),
      session("s-class-empty", { space_kind: "class", space_ref: "c1" }),
    ];
    const tree = buildSessionTree(nodes, sessions, spaces);

    expect(tree).toHaveLength(1);
    expect(tree[0].sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("세션에 안 딸린 개념은 아무 폴더에도 안 들어간다", () => {
    // session_id가 null인 카드가 있다(타입이 그렇다). 세지 않아야 폴더 합계가
    // 목록의 합과 맞는다.
    const tree = buildSessionTree([node("n1", null), node("n2", "s1")], [session("s1")], spaces);
    expect(tree[0].count).toBe(1);
  });

  it("공간 이름을 아직 못 받아도 폴더는 뜬다", () => {
    // 이름은 다른 질의(HomeSummary)에서 온다 — 지도는 그걸 기다리지 않는다.
    const tree = buildSessionTree(
      [node("n1", "s1")],
      [session("s1", { space_kind: "class", space_ref: "c9" })],
      [],
    );
    expect(tree[0].name).toBe("학급");
    expect(tree[0].spaceRef).toBe("c9");
  });

  it("개인 공간이 언제나 먼저, 학급은 이름순", () => {
    const nodes = [node("n1", "s1"), node("n2", "s2"), node("n3", "s3")];
    const sessions = [
      session("s2", { space_kind: "class", space_ref: "c1" }), // 2학년 3반
      session("s3", { space_kind: "class", space_ref: "c2" }), // 1학년 5반
      session("s1"),
    ];
    const tree = buildSessionTree(nodes, sessions, spaces);
    expect(tree.map((f) => f.name)).toEqual([
      "개인 공간",
      "1학년 5반 과학",
      "2학년 3반 지구과학",
    ]);
  });

  it("대화는 최근 것이 위로", () => {
    const nodes = [node("n1", "old"), node("n2", "new")];
    const sessions = [
      session("old", { updated_at: "2026-08-01T00:00:00Z" }),
      session("new", { updated_at: "2026-08-06T00:00:00Z" }),
    ];
    const tree = buildSessionTree(nodes, sessions, spaces);
    expect(tree[0].sessions.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("제목이 없으면 목록의 다른 곳과 같은 말을 쓴다", () => {
    const tree = buildSessionTree(
      [node("n1", "s1")],
      [session("s1", { title: "   " })],
      spaces,
    );
    expect(tree[0].sessions[0].title).toBe(UNTITLED_SESSION);
  });
});

describe("체크 상태", () => {
  const tree = buildSessionTree(
    [node("n1", "s1"), node("n2", "s2"), node("n3", "s3")],
    [session("s1"), session("s2"), session("s3")],
    [],
  );
  const folder = tree[0];

  it("전부 · 일부 · 없음을 가른다", () => {
    expect(folderCheckState(folder, new Set())).toBe("all");
    expect(folderCheckState(folder, new Set(["s1"]))).toBe("some");
    expect(folderCheckState(folder, new Set(["s1", "s2", "s3"]))).toBe("none");
  });

  it("대화 하나를 뒤집어도 입력 집합은 안 변한다", () => {
    const before = new Set(["s1"]);
    const after = toggleSession(before, "s2");
    expect([...before]).toEqual(["s1"]);
    expect(after.has("s2")).toBe(true);
  });

  it("전부 켜진 폴더를 누르면 전부 꺼진다", () => {
    expect([...toggleFolder(new Set(), folder)].sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("일부만 켜진 폴더를 누르면 **전부 켜진다**", () => {
    // 전부 끄기로 두면 하나만 남기고 껐던 학생이 그 하나까지 잃는다.
    expect([...toggleFolder(new Set(["s1", "s2"]), folder)]).toEqual([]);
  });

  it("전부 꺼진 폴더를 누르면 전부 켜진다", () => {
    expect([...toggleFolder(new Set(["s1", "s2", "s3"]), folder)]).toEqual([]);
  });

  it("폴더 토글이 다른 폴더의 숨김을 안 건드린다", () => {
    const two = buildSessionTree(
      [node("n1", "s1"), node("n2", "s2")],
      [session("s1"), session("s2", { space_kind: "class", space_ref: "c1" })],
      [],
    );
    const next = toggleFolder(new Set(["s2"]), two[0]);
    expect(next.has("s2")).toBe(true);
  });
});

describe("pruneHidden", () => {
  const tree = buildSessionTree(
    [node("n1", "s1")],
    [session("s1")],
    [],
  );

  it("지운 대화의 id를 버린다", () => {
    expect([...pruneHidden(["s1", "gone"], tree)]).toEqual(["s1"]);
  });

  it("**새 대화는 기본 보임이다**", () => {
    // 저장하는 것이 '숨긴 것'이라 성립하는 성질이다. '보이는 것'을 저장하면
    // 내일 한 대화가 저장 목록에 없어 지도에 안 뜬다 — 학생 눈에는 고장이다.
    const grown = buildSessionTree(
      [node("n1", "s1"), node("n2", "s-new")],
      [session("s1"), session("s-new")],
      [],
    );
    const hidden = pruneHidden(["s1"], grown);
    expect(hidden.has("s-new")).toBe(false);
  });
});
