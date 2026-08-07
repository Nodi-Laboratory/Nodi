/**
 * 부모 후보와 연결선 끝점의 규칙 (D206, 2026-08-07).
 *
 * 셋 다 **화면에서만** 드러나던 결함이라 값으로 못 박아 둔다.
 */

import { describe, expect, it } from "vitest";
import {
  magnetFor,
  MAGNET_DIST,
  SNAP_DIST,
  PARENT_Y_TOL,
  type Candidate,
} from "./detachDrag";
import { linkGeometry, EDGE_INSET, PAD_X } from "./connector";

const box = (x: number, y: number, w = 300, h = 120) => ({ x, y, w, h });
const none = new Set<string>();

describe("부모 후보는 위에 있어야 한다", () => {
  it("자기보다 아래에 있는 카드에는 안 붙는다", () => {
    // A가 아래에 있고 B(끄는 카드)가 그 위에서 다가온다. 예전에는 A가
    // 후보로 잡혀 **B가 A의 자식**이 되려 했다.
    const dragged = box(0, 0);
    const below: Candidate[] = [{ id: "A", rect: box(0, 200) }];
    expect(magnetFor(dragged, below, none).id).toBeNull();
  });

  it("위에 있는 카드에는 붙는다", () => {
    const dragged = box(0, 300);
    const above: Candidate[] = [{ id: "A", rect: box(0, 100) }];
    expect(magnetFor(dragged, above, none).id).toBe("A");
  });

  it("나란히 놓인 카드는 몇 px 어긋나도 후보로 남는다", () => {
    // 옆에 나란한 카드의 y가 조금 낮은 것은 흔하다. 0으로 자르면 그 흔한
    // 경우에 옆 카드로 못 붙는다.
    const dragged = box(0, 0);
    const beside: Candidate[] = [{ id: "A", rect: box(360, PARENT_Y_TOL - 1) }];
    expect(magnetFor(dragged, beside, none).id).toBe("A");
  });

  it("허용 어긋남을 넘으면 뺀다", () => {
    const dragged = box(0, 0);
    const beside: Candidate[] = [{ id: "A", rect: box(360, PARENT_Y_TOL + 40) }];
    expect(magnetFor(dragged, beside, none).id).toBeNull();
  });
});

describe("자석 띠", () => {
  it("걸리는 거리와 붙는 거리가 가깝다", () => {
    // "점선이 되는 조건이 실선이 되는 조건보다 너무 멀리 있어"(사용자
    // 2026-08-07). 띠가 넓으면 **끌려는 가는데 안 붙는 구간**이 길어진다.
    expect(MAGNET_DIST - SNAP_DIST).toBeLessThanOrEqual(40);
    // 그래도 같은 값은 아니다 — 경계에서 붙었다 떨어졌다 깜박인다.
    expect(MAGNET_DIST).toBeGreaterThan(SNAP_DIST);
  });

  it("자석 거리 밖이면 아무것도 안 걸린다", () => {
    const dragged = box(0, MAGNET_DIST + 400);
    const far: Candidate[] = [{ id: "A", rect: box(0, 0) }];
    expect(magnetFor(dragged, far, none).id).toBeNull();
  });
});

describe("아래로 가는 자식의 연결선", () => {
  it("끝점이 처음부터 왼쪽 세로줄에 선다", () => {
    // 카드가 만들어지는 중(폭이 아직 작다)에도 끝점이 같은 자리여야 한다 —
    // 글이 채워질 때 끝점이 옮겨 가는 것이 "어색하다"의 정체였다.
    const parent = box(0, 0, 560, 200);
    const 좁은자식 = linkGeometry(parent, box(0, 440, 132, 60));
    const 넓은자식 = linkGeometry(parent, box(0, 440, 560, 300));

    expect(좁은자식.sideA).toBe("bottom");
    expect(좁은자식.sideB).toBe("top");
    // 폭이 달라져도 끝점 x가 같다.
    expect(좁은자식.b.x).toBeCloseTo(넓은자식.b.x, 6);
    expect(좁은자식.a.x).toBeCloseTo(넓은자식.a.x, 6);
    // 그리고 그 x는 **왼쪽**이다(패딩 상자 왼쪽 변 + 여백).
    expect(좁은자식.b.x).toBeCloseTo(0 - PAD_X + EDGE_INSET, 6);
  });

  it("옆으로 멀리 떨어진 카드는 세로줄로 잇지 않는다", () => {
    // 옆 열까지 세로줄로 이으면 화면을 가로지르는 긴 직선이 된다.
    const g = linkGeometry(box(0, 0, 560, 200), box(1300, 440, 560, 200));
    expect(g.sideA).not.toBe("bottom");
  });
});
