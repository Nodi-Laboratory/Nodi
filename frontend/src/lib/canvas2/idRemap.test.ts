import { describe, expect, it } from "vitest";
import { idRemap, remapId, remapIdSet } from "./idRemap";

/**
 * 임시 id 교체가 초점·선택·편집을 데려가는지 (D187).
 *
 * 이 결함은 e2e로만 잡았는데 CI는 e2e를 안 돌린다 — 여기가 실질적인 방어선이다.
 */
describe("idRemap", () => {
  it("바뀐 것만 담는다", () => {
    const moved = idRemap(
      ["tmp-1", "tmp-2", "keep"],
      [{ id: "uuid-1" }, { id: "uuid-2" }, { id: "keep" }],
    );
    expect([...moved]).toEqual([
      ["tmp-1", "uuid-1"],
      ["tmp-2", "uuid-2"],
    ]);
  });

  it("저장분이 모자라면 그 자리는 건너뛴다", () => {
    // 경합으로 응답이 짧게 올 수 있다. 없는 것을 undefined로 옮기면
    // 초점이 통째로 사라진다 — 그럴 바엔 안 옮기는 편이 낫다.
    const moved = idRemap(["tmp-1", "tmp-2"], [{ id: "uuid-1" }]);
    expect(moved.get("tmp-1")).toBe("uuid-1");
    expect(moved.has("tmp-2")).toBe(false);
  });
});

describe("remapId", () => {
  const moved = new Map([["tmp-1", "uuid-1"]]);

  it("가리키던 id가 갈리면 따라간다", () => {
    expect(remapId("tmp-1", moved)).toBe("uuid-1");
  });

  it("표에 없으면 그대로 — 안 바뀐 것이지 지워진 것이 아니다", () => {
    expect(remapId("다른카드", moved)).toBe("다른카드");
  });

  it("null은 null이다", () => {
    expect(remapId(null, moved)).toBeNull();
  });
});

describe("remapIdSet", () => {
  const moved = new Map([
    ["tmp-1", "uuid-1"],
    ["tmp-2", "uuid-2"],
  ]);

  it("섞여 있어도 바뀐 것만 옮긴다", () => {
    const out = remapIdSet(new Set(["tmp-1", "그대로"]), moved);
    expect([...out].sort()).toEqual(["uuid-1", "그대로"].sort());
  });

  it("바뀐 것이 없으면 **같은 객체**를 돌려준다", () => {
    // 새 Set을 만들면 이걸 받는 아이템 전부의 memo가 깨진다(D145).
    const cur = new Set(["a", "b"]);
    expect(remapIdSet(cur, moved)).toBe(cur);
  });

  it("옮길 표가 비면 같은 객체를 돌려준다", () => {
    const cur = new Set(["tmp-1"]);
    expect(remapIdSet(cur, new Map())).toBe(cur);
  });

  it("빈 집합도 같은 객체다", () => {
    const cur = new Set<string>();
    expect(remapIdSet(cur, moved)).toBe(cur);
  });
});
