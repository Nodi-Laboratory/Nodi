import { describe, expect, it } from "vitest";
import {
  BREAK_DIST,
  MAGNET_DIST,
  SNAP_DIST,
  detachStep,
  laggedDelta,
  magnetFor,
  strain,
  tensionPull,
  type Candidate,
} from "./detachDrag";
import type { Rect } from "./rect";

const card = (x: number, y: number): Rect => ({ x, y, w: 560, h: 140 });
const NONE = new Set<string>();

describe("장력 — 끊기기 전에는 뒤처진다", () => {
  it("안 움직이면 안 따라온다", () => {
    expect(tensionPull(0)).toBe(0);
  });

  /**
   * **처음에는 뒤처지지 않아야 한다.** 저항이 처음부터 붙으면 카드를 조금
   * 다듬으려는 것마저 굼떠 보인다 — 저항은 끊길 무렵에만 느껴져야 한다.
   */
  it("조금 당길 때는 거의 그대로 따라온다", () => {
    const d = BREAK_DIST * 0.15;
    expect(tensionPull(d) / d).toBeGreaterThan(0.98);
  });

  /**
   * **끝에서는 확실히 버텨야 한다** (사용자 2026-08-05: "장력이 더 쌔야하고").
   * 처음 값(0.38)으로는 100px쯤 뒤처졌는데 저항이 거의 안 느껴진다고 했다.
   */
  it("끊길 무렵에는 카드 높이만큼 뒤처진다", () => {
    const d = BREAK_DIST * 0.98;
    const lag = d - tensionPull(d);
    expect(lag).toBeGreaterThan(130);
  });

  /**
   * 매여 있는 동안 뒤처짐은 **단조 증가**여야 한다. 중간에 줄면 당기는 중에
   * 카드가 앞으로 튕겨 보인다.
   */
  it("끊기기 전까지 뒤처짐이 커지기만 한다", () => {
    let prev = 0;
    for (let d = 0; d < BREAK_DIST; d += 5) {
      const lag = d - tensionPull(d);
      expect(lag).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = lag;
    }
  });

  /**
   * **끊기는 순간은 불연속이어야 한다.** 이 계단이 곧 "툭 끊겼다"는 느낌이다 —
   * 매끄럽게 이으면 저항이 슬그머니 사라질 뿐 사건으로 안 읽힌다.
   */
  it("끊기는 자리에서 뒤처짐이 한 번에 0이 된다", () => {
    const before = BREAK_DIST - 0.001;
    const lagBefore = before - tensionPull(before);
    expect(lagBefore).toBeGreaterThan(130);
    expect(BREAK_DIST - tensionPull(BREAK_DIST)).toBe(0);
  });

  it("끊긴 뒤에는 저항이 없다 — 포인터에 딱 붙는다", () => {
    expect(tensionPull(BREAK_DIST + 40)).toBe(BREAK_DIST + 40);
  });

  it("따라오는 거리는 당긴 방향 그대로다", () => {
    const p = laggedDelta(60, 80); // 길이 100
    // 방향이 같다(외적 0).
    expect(Math.abs(p.x * 80 - p.y * 60)).toBeLessThan(1e-9);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(tensionPull(100), 6);
  });

  it("팽팽함은 0에서 1로 찬다", () => {
    expect(strain(0)).toBe(0);
    expect(strain(BREAK_DIST / 2)).toBeCloseTo(0.5, 6);
    expect(strain(BREAK_DIST * 3)).toBe(1);
  });
});

describe("자석 — 가져다 대면 붙는다", () => {
  const cands: Candidate[] = [
    { id: "p", rect: card(0, 0) },
    { id: "q", rect: card(0, 2000) },
  ];

  it("멀면 아무것도 안 걸린다", () => {
    const m = magnetFor(card(0, 900), cands, NONE);
    expect(m.id).toBeNull();
    expect(m.pull).toEqual({ x: 0, y: 0 });
  });

  it("자석 반경에 들면 가장 가까운 하나가 걸린다", () => {
    const m = magnetFor(card(0, 140 + MAGNET_DIST - 20), cands, NONE);
    expect(m.id).toBe("p");
    expect(m.snapped).toBe(false);
    expect(m.grip).toBeGreaterThan(0);
  });

  it("붙는 거리 안에서는 실선으로 붙는다", () => {
    const m = magnetFor(card(0, 140 + SNAP_DIST - 10), cands, NONE);
    expect(m.snapped).toBe(true);
    expect(m.grip).toBe(1);
  });

  it("가까울수록 세게 끌린다", () => {
    const far = magnetFor(card(0, 140 + MAGNET_DIST - 10), cands, NONE);
    const near = magnetFor(card(0, 140 + SNAP_DIST + 10), cands, NONE);
    expect(Math.hypot(near.pull.x, near.pull.y)).toBeGreaterThan(
      Math.hypot(far.pull.x, far.pull.y),
    );
  });

  /**
   * **부모를 파고들면 안 된다.** 당기는 양이 간격을 넘으면 카드가 부모 위에
   * 겹쳐 보인다 — 붙는 것이 아니라 잡아먹는 것으로 읽힌다.
   */
  it("끌리는 양이 남은 간격을 넘지 않는다", () => {
    for (let gap = 4; gap <= SNAP_DIST; gap += 4) {
      const m = magnetFor(card(0, 140 + gap), cands, NONE);
      expect(Math.hypot(m.pull.x, m.pull.y)).toBeLessThanOrEqual(gap + 1e-6);
    }
  });

  /** 자기 가지에 자기를 붙이면 순환이 생긴다 — 애초에 후보에서 뺀다. */
  it("막힌 후보는 걸리지 않는다", () => {
    const m = magnetFor(card(0, 200), cands, new Set(["p"]));
    expect(m.id).toBeNull();
  });

  it("가장 가까운 하나만 고른다 — 경계에서 대상이 흔들리지 않게", () => {
    const two: Candidate[] = [
      { id: "가까움", rect: card(0, 0) },
      { id: "조금멂", rect: card(0, -400) },
    ];
    expect(magnetFor(card(0, 200), two, NONE).id).toBe("가까움");
  });
});

/**
 * 사용자가 말한 **세기**를 못 박는다 (2026-08-05).
 *
 *   "자석 연결이 잘 안돼 … 장력이 더 쌔야하고, 자석도 더 쎄야해.
 *    부모 노드 후보 근처로 카드가 끌려가야해. 그리고 끌려가서 그 근처로
 *    이동하면 바로 부모 노드와 붙어야해."
 *
 * 숫자를 조금씩 낮추다 보면 이 요구가 조용히 사라진다. 여기 적어 둔다.
 */
describe("세기 — 끌려가고, 바로 붙는다", () => {
  const cands: Candidate[] = [{ id: "p", rect: card(0, 0) }];

  it("카드 한 장 폭 밖에서도 자석이 걸린다", () => {
    expect(MAGNET_DIST).toBeGreaterThanOrEqual(560);
    const m = magnetFor(card(0, 140 + 500), cands, NONE);
    expect(m.id).toBe("p");
  });

  it("자석에 걸리면 **곧바로** 힘이 붙는다 — 경계에서 0이 아니다", () => {
    // 경계 바로 안쪽에서도 끌림이 눈에 보여야 한다.
    const m = magnetFor(card(0, 140 + MAGNET_DIST - 30), cands, NONE);
    expect(Math.hypot(m.pull.x, m.pull.y)).toBeGreaterThan(20);
  });

  it("붙는 거리 안에서는 남은 간격을 거의 다 메운다", () => {
    for (const gap of [60, 120, 200]) {
      const m = magnetFor(card(0, 140 + gap), cands, NONE);
      // 손을 떼기 전에 이미 제자리에 가 있어야 한다.
      expect(Math.hypot(m.pull.x, m.pull.y)).toBeGreaterThan(gap * 0.8);
      expect(m.snapped).toBe(true);
    }
  });

  it("붙는 거리가 자석 반경의 절반 아래다 — 끌리는 구간이 남는다", () => {
    expect(SNAP_DIST).toBeLessThan(MAGNET_DIST / 2);
  });
});

describe("detachStep — 한 프레임", () => {
  const rect = card(0, 500);
  const cands: Candidate[] = [{ id: "p", rect: card(0, 0) }];
  const base = { rect, candidates: cands, blocked: NONE };

  it("부모가 있으면 끊기기 전까지 뒤처진다", () => {
    const s = detachStep({ ...base, dx: 0, dy: -BREAK_DIST * 0.9, hasParent: true, broken: false });
    expect(s.breaking).toBe(false);
    expect(s.strain).toBeGreaterThan(0.8);
    expect(Math.abs(s.offset.y)).toBeLessThan(BREAK_DIST * 0.9);
    // 아직 매여 있으므로 자석은 안 돈다.
    expect(s.magnet.id).toBeNull();
  });

  it("끊기는 순간 포인터로 튄다", () => {
    const s = detachStep({ ...base, dx: 0, dy: -BREAK_DIST - 1, hasParent: true, broken: false });
    expect(s.breaking).toBe(true);
    expect(s.offset.y).toBe(-BREAK_DIST - 1);
    expect(s.strain).toBe(0);
  });

  /**
   * **끊기기 전에는 자석이 돌면 안 된다.** 부모에게서 멀어지는 중에 다른
   * 카드가 잡아당기면 카드가 어디로 가는지 알 수 없다.
   */
  it("매여 있는 동안에는 자석이 안 돈다", () => {
    const s = detachStep({
      ...base,
      // 후보 바로 옆까지 끌었지만 아직 끊김 거리 안이다.
      dx: 0,
      dy: -BREAK_DIST * 0.5,
      hasParent: true,
      broken: false,
      candidates: [{ id: "p", rect: card(0, 300) }],
    });
    expect(s.magnet.id).toBeNull();
  });

  it("끊긴 뒤에는 자석이 돈다", () => {
    const s = detachStep({ ...base, dx: 0, dy: -300, hasParent: true, broken: true });
    expect(s.strain).toBe(0);
    expect(s.magnet.id).toBe("p");
  });

  /** 뿌리 노드는 끊을 것이 없다 — 그냥 이동 도구가 된다. */
  it("부모가 없으면 장력 없이 그대로 따라온다", () => {
    const s = detachStep({
      ...base,
      dx: 40,
      dy: -40,
      hasParent: false,
      broken: false,
      // 자석 반경 **밖**에 둔다 — 안 그러면 끌림이 섞여 장력만 재지 못한다.
      candidates: [{ id: "멀다", rect: card(0, 4000) }],
    });
    expect(s.strain).toBe(0);
    expect(s.breaking).toBe(false);
    expect(s.offset).toEqual({ x: 40, y: -40 });
  });
});
