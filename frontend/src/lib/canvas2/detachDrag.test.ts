import { describe, expect, it } from "vitest";
import {
  ATTACH_GAP,
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
import { linkGeometry } from "./connector";
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
   * **양쪽에서 눌러 둔다** — 이 값은 두 번 조정됐고 방향이 반대였다:
   *
   *   0.38 → "저항이 거의 안 느껴진다"  (사용자 2026-08-05)
   *   0.55 → "너무 쎄"                  (사용자 2026-08-06)
   *
   * 한쪽 경계만 적어 두면 다음 조정이 반대쪽으로 넘어가도 아무도 못 잡는다.
   */
  it("끊길 무렵의 뒤처짐이 느껴지되 과하지 않다", () => {
    const d = BREAK_DIST * 0.98;
    const lag = d - tensionPull(d);
    /**
     * **비율로 잰다.** 절대 px로 박아 두면 끊김 거리를 조정할 때마다 이 테스트가
     * 같이 깨지는데, 정작 손맛은 그대로다(실측 2026-08-06: 260→150으로 줄이자
     * 느낌은 같은데 테스트만 깨졌다). 느낌을 정하는 것은 **끌린 거리 대비**
     * 얼마나 뒤처지느냐다.
     */
    expect(lag / d).toBeGreaterThan(0.3); // 안 느껴지면 안 된다
    expect(lag / d).toBeLessThan(0.55); // 손에서 떨어져 나간 것처럼 보이면 안 된다
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
    expect(lagBefore / before).toBeGreaterThan(0.3);
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

  /**
   * **걸리는 거리와 붙는 거리가 멀면 안 된다** (사용자 2026-08-06).
   *
   *   "자석이 시작되는 부분은 너무 빠른데 그 뒤로 연결되려면 더 가까이
   *    붙어야 한다. 이 사이의 텀을 줄여야 해."
   *
   * 그 구간이 길면 **끌려는 가는데 안 붙는** 구간이 길어진다 — 학생 눈에는
   * "반응은 하는데 연결이 안 된다"이다. 둘이 같으면 경계에서 깜박이므로
   * 완전히 붙이지도 않는다.
   */
  it("걸리는 거리와 붙는 거리가 가깝다", () => {
    const band = MAGNET_DIST - SNAP_DIST;
    expect(band).toBeGreaterThan(20); // 붙었다 떨어졌다 깜박이면 안 된다
    expect(band).toBeLessThan(120); // 끌리기만 하고 안 붙는 구간이 길면 안 된다
  });

  it("자석 반경 안이면 걸린다", () => {
    const m = magnetFor(card(0, 140 + MAGNET_DIST - 30), cands, NONE);
    expect(m.id).toBe("p");
  });

  it("자석에 걸리면 **곧바로** 힘이 붙는다 — 경계에서 0이 아니다", () => {
    // 경계 바로 안쪽에서도 끌림이 눈에 보여야 한다.
    const m = magnetFor(card(0, 140 + MAGNET_DIST - 30), cands, NONE);
    expect(Math.hypot(m.pull.x, m.pull.y)).toBeGreaterThan(20);
  });

  /**
   * **끌리되 선이 그려질 자리는 남긴다.**
   *
   * 연결선은 두 상자의 변에서 바깥으로 밀어낸 점을 잇는다. 간격이 좁아지면
   * 그 두 점이 서로를 지나쳐 선이 거꾸로 흐르고 카드 뒤에서 사라진다 —
   * 학생 눈에는 "가까이 갈수록 연결이 안 된다"로 보인다(사용자 2026-08-06).
   */
  it("자석이 끌고 간 자리에는 선이 들어갈 자리가 남는다", () => {
    for (const gap of [ATTACH_GAP + 20, SNAP_DIST, MAGNET_DIST - 10]) {
      const m = magnetFor(card(0, 140 + gap), cands, NONE);
      const pull = Math.hypot(m.pull.x, m.pull.y);
      // 끌리기는 한다.
      expect(pull).toBeGreaterThan(0);
      // 그러고도 남는 간격이 선 하나 몫은 된다.
      expect(gap - pull).toBeGreaterThanOrEqual(ATTACH_GAP - 1e-6);
    }
  });

  /** 이미 코앞이면 더 당기지 않는다 — 손과 싸우지 않는다. */
  it("이미 붙을 자리 안이면 안 당긴다", () => {
    const m = magnetFor(card(0, 140 + 40), cands, NONE);
    expect(Math.hypot(m.pull.x, m.pull.y)).toBe(0);
    expect(m.snapped).toBe(true);
  });

  it("붙는 거리가 카드 높이만큼은 된다 — 근처로 가면 붙는다", () => {
    expect(SNAP_DIST).toBeGreaterThanOrEqual(120);
    // 자석에 걸리는 것보다 늦게 붙어야 한다(순서가 뒤집히면 뜻이 없다).
    expect(SNAP_DIST).toBeLessThan(MAGNET_DIST);
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

/**
 * 자석이 남기는 자리와 **연결선이 실제로 그려지는 조건**을 잇는다 (D180).
 *
 * 사용자 보고 2026-08-06: "오히려 가까이 갈수록 연결이 안 되고, 일정 거리
 * 떨어져야 연결선이 생겨."
 *
 * 원인은 두 모듈 사이에 있었다. `connector.linkGeometry`는 두 상자의 변에서
 * 각각 **바깥으로** 조금 밀어낸 점을 잇는데, 간격이 그 두 번의 밀어냄보다
 * 좁아지면 끝점이 시작점을 지나쳐 **선이 거꾸로 흐른다**. 제어점도 각자
 * 바깥을 향하므로 곡선이 카드 뒤에서 매듭이 되어 사라진다.
 *
 * 자석은 그 자리로 카드를 끌고 갔다. 어느 한쪽만 보면 둘 다 멀쩡해 보이므로
 * 여기서 **함께** 못 박는다.
 */
describe("자석이 남긴 자리에 선이 그려진다", () => {
  const parent: Rect = { x: 0, y: 0, w: 560, h: 200 };

  /** 이 간격에서 부모→자식 선이 앞으로 흐르나(뒤집히지 않나). */
  function flowsForward(gap: number): boolean {
    const child: Rect = { x: 40, y: parent.h + gap, w: 380, h: 120 };
    const g = linkGeometry(parent, child);
    // 부모의 아래 변에서 나갔으면 자식 쪽 끝점은 **더 아래**여야 한다.
    return g.b.y > g.a.y;
  }

  it("붙는 자리 간격에서는 선이 앞으로 흐른다", () => {
    expect(flowsForward(ATTACH_GAP)).toBe(true);
  });

  /** 이 테스트가 상수의 하한을 잡는다 — 줄이면 바로 여기서 깨진다. */
  it("그보다 훨씬 좁으면 뒤집힌다 — 그래서 그 자리로 끌고 가면 안 된다", () => {
    expect(flowsForward(16)).toBe(false);
  });

  it("자석은 그 뒤집히는 자리로 카드를 끌고 가지 않는다", () => {
    const cands: Candidate[] = [{ id: "p", rect: parent }];
    for (let gap = ATTACH_GAP; gap <= MAGNET_DIST; gap += 20) {
      const child: Rect = { x: 40, y: parent.h + gap, w: 380, h: 120 };
      const m = magnetFor(child, cands, NONE);
      const left = gap - Math.hypot(m.pull.x, m.pull.y);
      expect(flowsForward(left)).toBe(true);
    }
  });
});
