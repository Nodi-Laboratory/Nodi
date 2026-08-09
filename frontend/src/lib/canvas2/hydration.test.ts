import { describe, expect, it } from "vitest";
import { planHydration, type HydrationState } from "./hydration";

/** 기본은 "세션 A를 여는 중" 상태. 필요한 것만 덮어쓴다. */
function state(over: Partial<HydrationState> = {}): HydrationState {
  return {
    sessionId: "A",
    hydratedFor: null,
    snapshotCount: null,
    ...over,
  };
}

describe("planHydration — 세션 진입", () => {
  it("스냅샷이 오기 전에는 채우지 않는다", () => {
    expect(planHydration(state({ snapshotCount: null }))).toEqual({
      clear: false,
      fill: false,
    });
  });

  it("글이 있으면 스냅샷으로 채운다", () => {
    expect(planHydration(state({ snapshotCount: 3 }))).toEqual({
      clear: false,
      fill: true,
    });
  });

  /**
   * 예전에는 여기서 **두 번째 쿼리를 기다렸다.** 카드가 0장이면 "v2 이전
   * 세션이라 nodes를 파싱해야 한다"와 "정말 빈 세션이다"가 안 갈렸기 때문이다.
   *
   * 이제 되살릴 답은 스냅샷이 함께 싣고 온다(`orphan_nodes`) — 기다릴 것이
   * 없으니 0장도 곧바로 채운다. 빈 세션이면 빈 화면이 맞다.
   */
  it("스냅샷이 비었어도 곧바로 채운다 — 기다릴 두 번째 쿼리가 없다", () => {
    expect(planHydration(state({ snapshotCount: 0 }))).toEqual({
      clear: false,
      fill: true,
    });
  });
});

describe("planHydration — 수화는 세션당 한 번 (D147 회귀)", () => {
  it("이미 채운 세션은 스냅샷이 다시 와도 덮지 않는다", () => {
    expect(planHydration(state({ hydratedFor: "A", snapshotCount: 3 }))).toEqual({
      clear: false,
      fill: false,
    });
  });

  /**
   * 사용자가 겪은 사고 그대로다 (2026-08-02).
   *
   * 빈 세션 → 질문 → AI 글 3개가 생기고 서버에 저장된다. 그런데 캔버스
   * 스냅샷 캐시는 여전히 `items: []`이다. 옛 코드는 여기서 "구 세션이구나"
   * 하고 nodes를 파싱해 화면을 덮었고, 그 `_legacy` 글을 옮기는 순간 서버에
   * **복제 행**이 생겼다.
   *
   * 파싱 갈래는 사라졌지만 규칙 자체는 그대로 필요하다 — 늦게 도착한 스냅샷
   * 하나만으로도 화면을 덮을 수 있다.
   */
  it("이미 채운 세션은 빈 스냅샷이 늦게 와도 덮지 않는다", () => {
    const plan = planHydration(state({ hydratedFor: "A", snapshotCount: 0 }));
    expect(plan.fill).toBe(false);
    expect(plan.clear).toBe(false);
  });
});

describe("planHydration — 세션 전환", () => {
  it("세션이 바뀌면 스냅샷을 기다리는 동안 이전 글을 비운다", () => {
    expect(
      planHydration(state({ sessionId: "B", hydratedFor: "A", snapshotCount: null })),
    ).toEqual({ clear: true, fill: false });
  });

  it("새 스냅샷이 이미 있으면 비우고 곧바로 채운다", () => {
    expect(
      planHydration(state({ sessionId: "B", hydratedFor: "A", snapshotCount: 2 })),
    ).toEqual({ clear: true, fill: true });
  });

  it("세션이 사라지면 화면을 비운다", () => {
    expect(planHydration(state({ sessionId: null, hydratedFor: "A" }))).toEqual({
      clear: true,
      fill: false,
    });
  });

  it("세션이 없고 채운 적도 없으면 아무 일도 하지 않는다", () => {
    expect(planHydration(state({ sessionId: null }))).toEqual({
      clear: false,
      fill: false,
    });
  });
});

describe("planHydration — 세션 A → B → A 왕복", () => {
  /**
   * 돌아왔을 때 옛 스냅샷을 그대로 쓰면 학생이 옮긴 좌표가 되돌아간다.
   * 그래서 호출부는 세션을 떠날 때 그 스냅샷 쿼리를 **캐시에서 버린다** —
   * 여기서는 "스냅샷이 다시 null부터 시작한다"로 나타난다.
   */
  it("돌아온 세션은 새 스냅샷이 도착해야 채워진다", () => {
    // 떠날 때: A로 채워져 있었고 B로 간다
    let s = state({ sessionId: "B", hydratedFor: "A", snapshotCount: null });
    expect(planHydration(s)).toEqual({ clear: true, fill: false });

    // B 수화 완료 후 다시 A로. A의 스냅샷은 버려졌으므로 아직 없다.
    s = state({ sessionId: "A", hydratedFor: "B", snapshotCount: null });
    expect(planHydration(s)).toEqual({ clear: true, fill: false });

    // 새 스냅샷 도착 — 서버가 정본이므로 옮긴 좌표가 그대로 온다.
    s = state({ sessionId: "A", hydratedFor: null, snapshotCount: 4 });
    expect(planHydration(s)).toEqual({ clear: false, fill: true });
  });
});
