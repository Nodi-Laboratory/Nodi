import { describe, expect, it } from "vitest";
import { clampDy, dyLimits, type GuardInput } from "./parentGuard";

/**
 * 카드 셋: 부모(y 0~100) → 자식(y 200~300) → 손자(y 400~500).
 */
const 기본 = {
  parentOf: (id: string) =>
    id === "child" ? "parent" : id === "grand" ? "child" : null,
  rectOf: (id: string) =>
    ({
      parent: { y: 0, h: 100 },
      child: { y: 200, h: 100 },
      grand: { y: 400, h: 100 },
    })[id] ?? null,
  childrenOf: (id: string) =>
    id === "parent" ? ["child"] : id === "child" ? ["grand"] : [],
} satisfies Omit<GuardInput, "moving">;

describe("자식은 부모 위로 못 올라간다", () => {
  it("자식은 부모 아랫변까지만 올라간다", () => {
    const { min } = dyLimits({ ...기본, moving: ["child"] });
    // 자식 윗변 200이 부모 아랫변 100까지 → -100.
    expect(min).toBe(-100);
    expect(clampDy(-500, { min, max: Infinity })).toBe(-100);
    expect(clampDy(-50, { min, max: Infinity })).toBe(-50);
  });

  it("아래로는 자식(손자)에 걸린다", () => {
    const { max } = dyLimits({ ...기본, moving: ["child"] });
    // 자식 아랫변 300이 손자 윗변 400까지 → +100.
    expect(max).toBe(100);
  });

  /**
   * 한쪽만 막으면 규칙이 아니다 — 부모를 내려서 같은 상태를 만들 수 있다.
   */
  it("부모도 자식 아래로는 못 내려간다", () => {
    const { max } = dyLimits({ ...기본, moving: ["parent"] });
    // 부모 아랫변 100이 자식 윗변 200까지 → +100.
    expect(max).toBe(100);
  });

  it("맨 위 카드는 위쪽 제한이 없다", () => {
    expect(dyLimits({ ...기본, moving: ["parent"] }).min).toBe(-Infinity);
  });

  /**
   * 가지를 통째로 끌면 간격이 안 변한다 — 막을 이유가 없다.
   */
  it("함께 움직이는 부모·자식은 서로를 안 막는다", () => {
    const r = dyLimits({ ...기본, moving: ["parent", "child", "grand"] });
    expect(r.min).toBe(-Infinity);
    expect(r.max).toBe(Infinity);
  });

  it("부모와 자식만 함께 끌면 손자한테만 걸린다", () => {
    const r = dyLimits({ ...기본, moving: ["parent", "child"] });
    expect(r.min).toBe(-Infinity);
    expect(r.max).toBe(100);
  });

  /**
   * 이미 어긋나 있으면(자식이 부모 위에 있는 옛 배치) 범위가 뒤집힌다.
   * 그대로 쓰면 `clamp`가 카드를 손과 상관없이 튕겨 보낸다.
   */
  it("이미 어긋난 배치에서는 세로를 잠근다", () => {
    const 뒤집힘 = {
      parentOf: (id: string) => (id === "child" ? "parent" : null),
      rectOf: (id: string) =>
        ({ parent: { y: 300, h: 100 }, child: { y: 0, h: 100 }, other: { y: 50, h: 10 } })[
          id
        ] ?? null,
      childrenOf: (id: string) => (id === "parent" ? ["child"] : []),
    };
    // 자식은 부모(300~400) 아래로 내려가야 하는데 자기 자식은 없다 →
    // min=400, max=Infinity. 뒤집히지 않는 경우다.
    expect(dyLimits({ ...뒤집힘, moving: ["child"] }).min).toBe(400);

    // 부모는 위로 제한이 없고 아래로는 자식 윗변(0)까지 → max = -400.
    // min(-Infinity) < max(-400)이라 뒤집히지 않는다.
    expect(dyLimits({ ...뒤집힘, moving: ["parent"] }).max).toBe(-400);
  });

  it("배치 전(좌표 없음)이면 아무것도 안 막는다", () => {
    const r = dyLimits({
      moving: ["child"],
      parentOf: () => "parent",
      rectOf: () => null,
      childrenOf: () => [],
    });
    expect(r.min).toBe(-Infinity);
    expect(r.max).toBe(Infinity);
  });
});
