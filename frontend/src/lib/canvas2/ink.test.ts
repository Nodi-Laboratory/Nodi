import { describe, expect, it } from "vitest";
import { toBlocks } from "./markup";
import { splitRun, toInkDoc, type InkRun } from "./ink";

/**
 * D164 — "써지는" 애니메이션의 핵심 불변식은 **절대 색인의 안정성**이다.
 *
 * 글자 하나가 더 도착했을 때 앞선 글자의 색인이 흔들리면 React가 span을
 * 재사용하지 못해 이미 다 써진 글이 매 프레임 다시 써진다. 눈으로는
 * "깜빡인다" 정도로만 보여서 실제로 놓치기 쉬운 결함이라 테스트로 잡는다.
 */

/** 스트리밍을 흉내내 앞에서부터 잘라 색인 맵을 뽑는다. */
function indexMap(body: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const b of toInkDoc(toBlocks(body)).blocks) {
    for (const r of b.runs) {
      for (let i = 0; i < r.text.length; i++) m.set(r.start + i, r.text[i]);
    }
  }
  return m;
}

describe("toInkDoc", () => {
  it("런에 문서 전체 기준 시작 색인을 매긴다", () => {
    const doc = toInkDoc(toBlocks("가나**다라**"));
    expect(doc.total).toBe(4);
    const runs = doc.blocks[0].runs;
    expect(runs.map((r) => [r.start, r.text, r.b])).toEqual([
      [0, "가나", false],
      [2, "다라", true],
    ]);
  });

  it("블록이 여럿이어도 색인이 이어진다 (줄바꿈은 세지 않는다)", () => {
    const doc = toInkDoc(toBlocks("첫문단\n\n- 항목"));
    expect(doc.blocks.map((b) => b.start)).toEqual([0, 3]);
    expect(doc.total).toBe(5);
  });

  it("빈 본문은 총 0자다", () => {
    expect(toInkDoc(toBlocks("")).total).toBe(0);
  });

  it("글자가 덧붙어도 앞선 글자의 색인은 변하지 않는다", () => {
    const full = "물의 **끓는점**은 100도다.\n\n- 압력이 낮으면 낮아진다\n- 높으면 높아진다";
    let prev = new Map<number, string>();
    for (let n = 1; n <= full.length; n++) {
      const cur = indexMap(full.slice(0, n));
      for (const [at, ch] of prev) {
        // 아직 살아 있는 색인이라면 같은 글자여야 한다. (마커가 반쪽만 온
        // 순간에는 글자가 잠깐 사라질 수 있지만, 자리가 **바뀌면** 안 된다.)
        if (cur.has(at)) expect(cur.get(at), `n=${n} at=${at}`).toBe(ch);
      }
      prev = cur;
    }
  });
});

describe("splitRun", () => {
  const run = (text: string, start = 0): InkRun => ({ text, b: false, h: false, start });

  it("꼬리 밖이면 통째로 마른 글이다", () => {
    expect(splitRun(run("가나다"), 10)).toEqual({ dry: "가나다", wet: [] });
  });

  it("tailFrom이 Infinity면 절대 쪼개지 않는다 (재수화)", () => {
    expect(splitRun(run("가나다"), Infinity)).toEqual({ dry: "가나다", wet: [] });
  });

  it("꼬리 경계에서 앞뒤로 가른다", () => {
    expect(splitRun(run("가나다라", 10), 12)).toEqual({
      dry: "가나",
      wet: [
        [12, "다"],
        [13, "라"],
      ],
    });
  });

  it("전부 꼬리면 마른 글이 없다", () => {
    expect(splitRun(run("가나", 0), 0)).toEqual({
      dry: "",
      wet: [
        [0, "가"],
        [1, "나"],
      ],
    });
  });

  it("서로게이트 쌍을 반으로 자르지 않는다", () => {
    const { wet } = splitRun(run("가🙂나", 0), 0);
    expect(wet.map(([, ch]) => ch)).toEqual(["가", "🙂", "나"]);
    // 색인은 코드 유닛 기준을 유지한다 — 런의 start 누적과 같은 단위여야 한다.
    expect(wet.map(([at]) => at)).toEqual([0, 1, 3]);
  });

  it("꼬리 글자의 색인은 문서 전체 기준이라 유일하다", () => {
    const doc = toInkDoc(toBlocks("가나다\n\n라마바"));
    const seen = new Set<number>();
    for (const b of doc.blocks) {
      for (const r of b.runs) {
        for (const [at] of splitRun(r, 0).wet) {
          expect(seen.has(at)).toBe(false);
          seen.add(at);
        }
      }
    }
    expect(seen.size).toBe(doc.total);
  });
});
