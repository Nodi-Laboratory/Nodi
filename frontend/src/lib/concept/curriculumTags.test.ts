import { describe, expect, it } from "vitest";
import {
  CANVAS_H,
  CANVAS_W,
  CARD_MARGIN,
  CARD_W,
  CENTER,
  TAG_GOLDEN_ANGLE,
  TAG_RING_RADIUS,
  slotAnchor,
} from "./curriculumTags";

/**
 * 태그 슬롯 앵커 회귀 (D105).
 *
 * 캔버스 배치의 뿌리다. 슬롯 i의 좌표가 바뀌면 **저장된 세션의 배치가 통째로
 * 달라진다** — 좌표를 저장하지 않고 매번 재계산하는 설계라, 이 함수가
 * 결정론이고 안정적이라는 것이 "새로고침해도 같은 그림"의 유일한 근거다.
 */

describe("슬롯 앵커", () => {
  it("슬롯 0은 중심 바로 위", () => {
    const a = slotAnchor(0);
    expect(a.x).toBeCloseTo(CENTER.x, 6);
    expect(a.y).toBeCloseTo(CENTER.y - TAG_RING_RADIUS, 6);
  });

  it("모든 슬롯이 중심에서 같은 반경", () => {
    for (let i = 0; i < 24; i++) {
      const a = slotAnchor(i);
      expect(Math.hypot(a.x - CENTER.x, a.y - CENTER.y)).toBeCloseTo(TAG_RING_RADIUS, 6);
    }
  });

  it("결정론 — 같은 슬롯은 항상 같은 좌표", () => {
    expect(slotAnchor(7)).toEqual(slotAnchor(7));
  });

  it("슬롯이 늘어도 기존 슬롯 좌표는 안 움직인다 (D90)", () => {
    // 재배치가 없다는 계약. i의 값은 i에만 의존해야 한다.
    const before = [0, 1, 2].map(slotAnchor);
    const after = [0, 1, 2].map(slotAnchor); // 그 사이 5,6,7이 생겼다고 가정해도 동일
    [5, 6, 7].forEach(slotAnchor);
    expect(after).toEqual(before);
  });

  it("서로 다른 슬롯은 서로 다른 자리", () => {
    const seen = new Set(
      Array.from({ length: 30 }, (_, i) => {
        const a = slotAnchor(i);
        return `${a.x.toFixed(3)},${a.y.toFixed(3)}`;
      }),
    );
    expect(seen.size).toBe(30);
  });

  it("이웃한 슬롯 번호는 각도상 멀리 떨어진다 (황금각)", () => {
    // 연속으로 만들어진 두 태그가 붙어 앉으면 클러스터가 섞여 보인다.
    const angle = (i: number) => -Math.PI / 2 + i * TAG_GOLDEN_ANGLE;
    const diff = Math.abs(((angle(1) - angle(0)) % (2 * Math.PI)));
    expect(diff).toBeGreaterThan(Math.PI / 3); // 60도 이상
  });
});

describe("치수 상수", () => {
  it("중심은 캔버스 한가운데", () => {
    expect(CENTER).toEqual({ x: CANVAS_W / 2, y: CANVAS_H / 2 });
  });

  it("카드 폭·여백이 양수", () => {
    expect(CARD_W).toBeGreaterThan(0);
    expect(CARD_MARGIN).toBeGreaterThan(0);
  });
});
