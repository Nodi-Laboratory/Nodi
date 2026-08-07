/**
 * 밀어내기 (D207).
 *
 * **무작위 장면으로 대량 검증한다.** 손으로 고른 예제는 내가 이미 이해한
 * 경우만 덮는다 — 겹침은 카드 배치가 조금만 달라져도 새로운 방식으로 생긴다
 * (inkScene.fuzz와 같은 태도).
 */

import { describe, expect, it } from "vitest";
import { anyOverlap, minTranslation, pushAway, type PushCandidate } from "./pushAway";
import type { Rect } from "./rect";

const box = (x: number, y: number, w = 300, h = 150): Rect => ({ x, y, w, h });

/** 씨앗 고정 난수 — 실패를 재현할 수 있어야 한다. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("최소 이동 벡터", () => {
  it("안 겹치면 안 움직인다", () => {
    expect(minTranslation(box(0, 0), box(1000, 1000))).toEqual({ dx: 0, dy: 0 });
  });

  it("한 축으로만 민다", () => {
    // 대각선으로 밀면 카드가 멀리 날아가고 무엇이 왜 움직였는지 안 보인다.
    const t = minTranslation(box(0, 0), box(50, 20));
    expect(t.dx === 0 || t.dy === 0).toBe(true);
  });

  it("얕은 쪽으로 빠져나간다", () => {
    // 세로로 20만 겹치고 가로로 250 겹치면 세로로 빠지는 게 짧다.
    const t = minTranslation(box(0, 0), box(50, 130));
    expect(t.dx).toBe(0);
    expect(t.dy).toBeLessThan(0); // 위로 비킨다
  });
});

describe("밀어내기", () => {
  it("강도가 0이면 아무도 안 밀린다 — 기능을 끈 것과 같다", () => {
    const out = pushAway([box(0, 0)], [{ id: "a", rect: box(10, 10) }], {
      gap: 40,
      strength: 0,
    });
    expect(out.size).toBe(0);
  });

  it("겹친 카드만 결과에 담긴다", () => {
    const statics: PushCandidate[] = [
      { id: "가까움", rect: box(20, 20) },
      { id: "멂", rect: box(4000, 4000) },
    ];
    const out = pushAway([box(0, 0)], statics, { gap: 40, strength: 1 });
    expect(out.has("가까움")).toBe(true);
    expect(out.has("멂")).toBe(false);
  });

  it("밀어낸 뒤에는 끄는 카드와 겹치지 않는다", () => {
    const moving = box(0, 0, 400, 200);
    const statics: PushCandidate[] = [
      { id: "a", rect: box(60, 40) },
      { id: "b", rect: box(120, 90) },
      { id: "c", rect: box(-80, 60) },
    ];
    const out = pushAway([moving], statics, { gap: 40, strength: 1 });
    for (const s of statics) {
      const d = out.get(s.id) ?? { dx: 0, dy: 0 };
      const moved = { ...s.rect, x: s.rect.x + d.dx, y: s.rect.y + d.dy };
      expect(anyOverlap([moving, moved], 40)).toBe(false);
    }
  });

  it("무작위 장면 600개에서 끄는 카드와의 겹침이 사라진다", () => {
    const rand = rng(20260807);
    let 남은겹침 = 0;
    for (let n = 0; n < 600; n++) {
      const moving = box(
        rand() * 400 - 200,
        rand() * 400 - 200,
        180 + rand() * 400,
        90 + rand() * 240,
      );
      const count = 2 + Math.floor(rand() * 6);
      const statics: PushCandidate[] = Array.from({ length: count }, (_, i) => ({
        id: `s${i}`,
        rect: box(
          rand() * 900 - 450,
          rand() * 900 - 450,
          180 + rand() * 400,
          90 + rand() * 240,
        ),
      }));
      const gap = 20 + Math.floor(rand() * 60);
      const out = pushAway([moving], statics, { gap, strength: 1, passes: 4 });
      for (const s of statics) {
        const d = out.get(s.id) ?? { dx: 0, dy: 0 };
        const moved = { ...s.rect, x: s.rect.x + d.dx, y: s.rect.y + d.dy };
        if (anyOverlap([moving, moved], gap)) 남은겹침++;
      }
    }
    // 판 수에 상한이 있으므로 **완벽**을 요구하지는 않는다. 다만 압도적으로
    // 풀려야 한다 — 안 풀리면 겹친 카드가 화면에 남는다.
    expect(남은겹침).toBe(0);
  });

  it("끄는 카드가 멀어지면 밀림이 사라진다 — 원래 자리로 돌아갈 수 있다", () => {
    const statics: PushCandidate[] = [{ id: "a", rect: box(0, 0) }];
    const 가까이 = pushAway([box(20, 20)], statics, { gap: 40, strength: 1 });
    const 멀리 = pushAway([box(3000, 3000)], statics, { gap: 40, strength: 1 });
    expect(가까이.size).toBe(1);
    expect(멀리.size).toBe(0);
  });

  it("같은 입력이면 같은 결과다 — 손을 멈추면 화면도 멈춘다", () => {
    const statics: PushCandidate[] = [
      { id: "a", rect: box(30, 30) },
      { id: "b", rect: box(90, 70) },
    ];
    const one = pushAway([box(0, 0)], statics, { gap: 40, strength: 1 });
    const two = pushAway([box(0, 0)], statics, { gap: 40, strength: 1 });
    expect([...one.entries()]).toEqual([...two.entries()]);
  });
});
