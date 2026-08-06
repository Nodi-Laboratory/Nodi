import { describe, expect, it } from "vitest";
import {
  chainOf,
  decideCoach,
  DEFAULT_MIN_CARDS,
  REARM_GAP,
  type CoachItem,
} from "./questionCoach";

/**
 * 질문 방향성 코치의 발동 규칙 (D194).
 *
 * **눈으로는 못 잡는다** — 안 떠도 화면은 멀쩡하고, 잘못 떠도 그럴싸하다.
 * 여기서 고정하지 않으면 "가끔 안 뜨는 것 같다"로만 남는다.
 */

function card(id: string, parent: string | null, seq = 0): CoachItem {
  return { id, parentItemId: parent, kind: "concept", source: "ai", seq };
}

/** 뿌리부터 `n`개가 이어진 사슬. */
function chain(n: number): CoachItem[] {
  return Array.from({ length: n }, (_, i) =>
    card(`c${i + 1}`, i === 0 ? null : `c${i}`, i),
  );
}

const NONE: ReadonlySet<string> = new Set();

describe("chainOf", () => {
  it("뿌리부터 자기까지 순서대로", () => {
    expect(chainOf(chain(3), "c3").map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("옆 가지는 안 센다 — 브랜치는 하나의 줄기다", () => {
    const items = [...chain(2), card("side", "c1", 9)];
    expect(chainOf(items, "c2").map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("부모가 사라졌으면 거기서 멈춘다", () => {
    // 학생이 별 포인터로 가지를 떼면(D180) 부모가 없어질 수 있다.
    expect(chainOf([card("x", "없는부모")], "x").map((c) => c.id)).toEqual(["x"]);
  });

  it("순환이 있어도 안 멈춘다", () => {
    const a = card("a", "b");
    const b = card("b", "a");
    expect(chainOf([a, b], "a")).toHaveLength(2);
  });
});

describe("decideCoach", () => {
  const n = DEFAULT_MIN_CARDS; // 3

  it("사슬이 n+1이 되면 건다", () => {
    const got = decideCoach(chain(n + 1), `c${n + 1}`, n, NONE);
    expect(got.should).toBe(true);
    expect(got.depth).toBe(n + 1);
  });

  it("n개까지는 안 건다 — 방향성을 볼 만큼 안 쌓였다", () => {
    const got = decideCoach(chain(n), `c${n}`, n, NONE);
    expect(got.should).toBe(false);
    expect(got.reason).toBe("too-shallow");
  });

  it("**브랜치 하나당 한 번이다**", () => {
    const items = chain(n + 2);
    const spoke = new Set([`c${n + 1}`]);
    expect(decideCoach(items, `c${n + 2}`, n, spoke).should).toBe(false);
  });

  it("n+3만큼 더 깊어지면 다시 건다", () => {
    const depth = n + 1 + n + REARM_GAP;
    const items = chain(depth);
    const spoke = new Set([`c${n + 1}`]);
    expect(decideCoach(items, `c${depth}`, n, spoke).should).toBe(true);
  });

  it("한 장 모자라면 아직 안 건다 — 경계가 흐르면 잔소리가 된다", () => {
    const depth = n + 1 + n + REARM_GAP - 1;
    const items = chain(depth);
    const spoke = new Set([`c${n + 1}`]);
    expect(decideCoach(items, `c${depth}`, n, spoke).should).toBe(false);
  });

  it("옆 가지에서 건 것은 이 줄기와 무관하다", () => {
    // 브랜치가 판정 단위다 — 다른 줄기에서 말을 걸었다고 이쪽이 조용할 이유가 없다.
    const items = [...chain(n + 1), card("side", "c1", 9)];
    const spoke = new Set(["side"]);
    expect(decideCoach(items, `c${n + 1}`, n, spoke).should).toBe(true);
  });

  it("학생 메모에는 안 건다 — 트리 노드가 아니다", () => {
    const items = [
      ...chain(n),
      { id: "note", parentItemId: `c${n}`, kind: "note", source: "user", seq: 9 },
    ];
    const got = decideCoach(items, "note", n, NONE);
    expect(got.should).toBe(false);
    expect(got.reason).toBe("not-a-tree-node");
  });

  it("도판·클립에도 안 건다", () => {
    for (const kind of ["figure", "clip"]) {
      const items = [
        ...chain(n),
        { id: kind, parentItemId: `c${n}`, kind, source: "ai", seq: 9 },
      ];
      expect(decideCoach(items, kind, n, NONE).should).toBe(false);
    }
  });

  it("n을 바꾸면 발동 시점이 따라간다", () => {
    expect(decideCoach(chain(6), "c6", 5, NONE).should).toBe(true);
    expect(decideCoach(chain(5), "c5", 5, NONE).should).toBe(false);
  });

  it("n이 0이나 음수여도 죽지 않는다", () => {
    // 관리자가 손으로 넣는 값이다. clamp가 없으면 사슬 하나에도 말을 건다.
    expect(decideCoach(chain(1), "c1", 0, NONE).should).toBe(false);
    expect(decideCoach(chain(2), "c2", -5, NONE).should).toBe(true);
  });

  it("없는 카드에는 안 건다", () => {
    expect(decideCoach(chain(5), "없음", n, NONE).should).toBe(false);
  });

  it("재발동 간격은 관리자 콘솔이 보여 주는 수와 같아야 한다", () => {
    // 콘솔은 노브 옆에 "재발동까지 n+3장"을 붙여 보여 준다(사용자 지시
    // 2026-08-06). 그 3은 서버 상수(`services/question_coach.py`의 REARM_GAP)에서
    // 오고 판정은 여기서 한다 — 갈리면 **콘솔이 거짓말을 하는데 아무 데도 안
    // 드러난다.** 이 값을 고치려면 서버 상수도 같이 고쳐야 한다.
    expect(REARM_GAP).toBe(3);
  });
});
