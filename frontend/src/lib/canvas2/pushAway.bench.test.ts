/**
 * 밀어내기 비용 측정 (D207 최적화, 2026-08-07).
 *
 * 이 계산은 **드래그 프레임마다** 돈다. 60fps를 지키려면 한 판이 16ms 안에
 * 끝나야 하고, 다른 일(연결선·transform 쓰기)도 그 안에서 같이 해야 하므로
 * 실제 예산은 그보다 훨씬 작다.
 *
 * 시험이 아니라 **자**다. 그래서 임계는 넉넉히 두고(회귀만 잡는다) 값은
 * 출력해 눈으로 본다.
 */

import { describe, expect, it } from "vitest";
import { pushAway, type PushCandidate } from "./pushAway";
import type { Rect } from "./rect";

function scene(n: number): { moving: Rect[]; statics: PushCandidate[] } {
  // 열 배치를 흉내 낸다 — 실제 캔버스가 그렇게 놓인다(D123).
  const statics: PushCandidate[] = [];
  const perCol = 12;
  for (let i = 0; i < n; i++) {
    statics.push({
      id: `s${i}`,
      rect: {
        x: Math.floor(i / perCol) * 760,
        y: (i % perCol) * 320,
        w: 560,
        h: 180,
      },
    });
  }
  return { moving: [{ x: 380, y: 160, w: 560, h: 180 }], statics };
}

function 잰다(n: number, frames = 60): number {
  const { moving, statics } = scene(n);
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    // 매 프레임 조금씩 다른 자리 — 캐시가 아니라 계산을 잰다.
    const m = [{ ...moving[0], x: moving[0].x + f, y: moving[0].y + f * 0.5 }];
    pushAway(m, statics, { gap: 48, strength: 1 });
  }
  return (performance.now() - t0) / frames;
}

describe("밀어내기 비용", () => {
  it("카드 수에 따른 한 프레임 비용", () => {
    const 결과 = [20, 60, 150, 300].map((n) => ({ n, ms: 잰다(n) }));
    for (const r of 결과) {
      console.log(`  카드 ${String(r.n).padStart(3)}장 → ${r.ms.toFixed(3)}ms/프레임`);
    }
    const 큰것 = 결과[결과.length - 1];
    /**
     * 카드 300장에서 **1ms 안에** 끝나야 한다.
     *
     * 넓은 단계 가지치기를 넣기 전에는 2.44ms였고 카드 수의 제곱으로 자랐다
     * (600장이면 10ms — 한 프레임 예산 16.7ms의 절반). 지금은 0.14ms이고
     * 카드가 늘어도 거의 안 변한다.
     *
     * 이 판정이 없으면 N² 루프가 조용히 되살아난다 — 카드가 적은 개발용
     * 세션에서는 아무도 못 느끼고, 학기 말 캔버스에서만 버벅인다.
     */
    expect(큰것.ms).toBeLessThan(1.5);
    /**
     * 그리고 **제곱으로 자라지 않아야** 한다.
     *
     * 60장 대비 300장은 카드가 5배다 — N²이면 25배가 나온다. 3배 안이면
     * 가지치기가 살아 있다는 뜻이다.
     *
     * ⚠️ 가장 작은 판(20장)과 견주지 마라. 그 값이 워낙 작아 기계가 바쁘면
     * 비율이 통째로 흔들린다(실측: dev 서버를 켠 채 돌리니 이 판정만 깨졌다).
     */
    const 중간 = 결과.find((r) => r.n === 60)!;
    expect(큰것.ms).toBeLessThan(중간.ms * 3);
  });
});
