/**
 * 수식 파싱 (D210 3-1).
 *
 * 화면에서 보면 "수식이 안 나온다"까지만 알 수 있다 — 어느 표기에서 어떻게
 * 어긋났는지는 여기서 잡는다. 특히 **스트리밍 중간 상태**가 중요하다.
 */

import { describe, expect, it } from "vitest";
import { toBlocks, toRuns } from "./markup";

const runsOf = (body: string) => toBlocks(body).map((b) => toRuns(b.tokens));

describe("인라인 수식", () => {
  it("$…$를 하나의 수식 런으로 만든다", () => {
    const [runs] = runsOf("속력은 $v = d/t$ 이다.");
    const math = runs.filter((r) => r.m);
    expect(math).toHaveLength(1);
    expect(math[0].m).toBe("i");
    expect(math[0].text).toBe("v = d/t");
  });

  it("\\(…\\) 표기도 같은 토큰으로 흡수한다", () => {
    // 모델이 어느 쪽을 뱉을지 고정할 수 없다 — 둘 다 받는다.
    const [runs] = runsOf("속력은 \\(v = d/t\\) 이다.");
    expect(runs.filter((r) => r.m)).toHaveLength(1);
    expect(runs.find((r) => r.m)!.text).toBe("v = d/t");
  });

  it("수식은 이웃 글자와 합쳐지지 않는다", () => {
    const [runs] = runsOf("앞 $x$ 뒤");
    expect(runs.map((r) => (r.m ? `M(${r.text})` : r.text))).toEqual([
      "앞 ",
      "M(x)",
      " 뒤",
    ]);
  });

  it("굵게 안의 수식도 수식이다", () => {
    const [runs] = runsOf("**핵심은 $E=mc^2$ 이다**");
    const m = runs.find((r) => r.m)!;
    expect(m.b).toBe(true);
    expect(m.text).toBe("E=mc^2");
  });
});

describe("블록 수식", () => {
  it("$$…$$는 제 블록이 된다", () => {
    const blocks = toBlocks("앞 문단\n\n$$\nE = mc^2\n$$\n\n뒤 문단");
    expect(blocks.map((b) => b.type)).toEqual(["p", "math", "p"]);
    expect(blocks[1].tokens).toHaveLength(1);
    expect(blocks[1].tokens[0].m).toBe("b");
    expect(blocks[1].tokens[0].ch).toBe("E = mc^2");
  });

  it("\\[…\\] 표기도 같다", () => {
    const blocks = toBlocks("앞\n\n\\[ a^2 + b^2 = c^2 \\]\n\n뒤");
    expect(blocks.map((b) => b.type)).toEqual(["p", "math", "p"]);
    expect(blocks[1].tokens[0].ch).toBe("a^2 + b^2 = c^2");
  });
});

describe("닫히지 않은 수식은 렌더하지 않는다", () => {
  /**
   * 스트리밍 중에는 여는 기호만 와 있는 순간이 **매 턴** 생긴다. 그때
   * 렌더를 시도하면 글자가 들어올 때마다 수식이 다시 그려져 깜빡인다.
   */
  it("$ 하나만 온 상태", () => {
    const [runs] = runsOf("속력은 $v = d");
    expect(runs.some((r) => r.m)).toBe(false);
    expect(runs.map((r) => r.text).join("")).toBe("속력은 $v = d");
  });

  it("$$가 열리기만 한 상태", () => {
    const blocks = toBlocks("앞\n\n$$\nE = mc");
    expect(blocks.some((b) => b.type === "math")).toBe(false);
  });

  it("빈 수식($$)은 수식이 아니다", () => {
    const [runs] = runsOf("값이 $$ 없다");
    expect(runs.some((r) => r.m)).toBe(false);
  });

  it("글자 사이의 달러 기호는 수식이 아니다", () => {
    // "$5 였다" 같은 문장에서 닫는 $가 없으면 그대로 둔다.
    const [runs] = runsOf("가격은 $5 였다");
    expect(runs.some((r) => r.m)).toBe(false);
  });
});

describe("기존 마크업은 그대로다", () => {
  it("굵게·형광펜·목록이 안 깨진다", () => {
    const blocks = toBlocks("- **굵게** 와 ==형광== 항목");
    expect(blocks[0].type).toBe("li");
    const runs = toRuns(blocks[0].tokens);
    expect(runs.find((r) => r.b)?.text).toBe("굵게");
    expect(runs.find((r) => r.h)?.text).toBe("형광");
  });
});
