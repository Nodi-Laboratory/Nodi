import { describe, expect, it } from "vitest";
import {
  CARD_CHROME_H,
  CARD_CX,
  CARD_H_PER_LINE,
  CARD_STREAM_LINES,
  SOURCES_EXTRA_H,
  cardHeight,
  estimateBodyLines,
} from "./cardMetrics";
import { CARD_W } from "./curriculumTags";
import type { Block, Concept } from "./types";

/**
 * 카드 높이 추정 회귀 (D105).
 *
 * 이 값은 d3-force의 **충돌 반경**에 그대로 들어간다. 틀리면 카드가 겹치거나
 * 쓸데없이 벌어진다 — 화면을 봐야만 알 수 있는 종류의 버그라 테스트가 특히 값싸다.
 */

const p = (text: string): Block => ({
  type: "p",
  typing: false,
  tokens: Array.from(text).map((ch) => ({ ch, b: false, h: false })),
});

const concept = (over: Partial<Concept> = {}): Concept =>
  ({ id: "c1", title: "", cluster: "", blocks: [], related: [], x: 0, y: 0, done: true, ...over }) as Concept;

describe("본문 줄 수 추정", () => {
  it("빈 본문은 0줄", () => {
    expect(estimateBodyLines([])).toBe(0);
  });

  it("문단은 아무리 짧아도 최소 1줄", () => {
    expect(estimateBodyLines([p("가")])).toBe(1);
  });

  it("한글은 글자 수가 아니라 UTF-8 바이트로 잰다", () => {
    // 한 줄 = 50바이트. 한글 1자 = 3바이트 → 17자까지 1줄, 18자부터 2줄.
    expect(estimateBodyLines([p("가".repeat(16))])).toBe(1); // 48B
    expect(estimateBodyLines([p("가".repeat(17))])).toBe(2); // 51B
  });

  it("문단마다 줄바꿈 잔여분이 반영된다", () => {
    // 문단 두 개는 각각 올림되므로 합쳐서 재는 것보다 크거나 같다.
    const two = estimateBodyLines([p("가".repeat(10)), p("가".repeat(10))]);
    const one = estimateBodyLines([p("가".repeat(20))]);
    expect(two).toBe(2);
    expect(two).toBeGreaterThanOrEqual(one);
  });

  it("p가 아닌 블록은 세지 않는다", () => {
    // 지금은 p만 있지만, 블록 종류가 늘어도 줄 수 추정이 오염되지 않아야 한다.
    const other = { ...p("무시"), type: "quote" } as unknown as Block;
    expect(estimateBodyLines([other])).toBe(0);
  });
});

describe("카드 높이", () => {
  it("본문이 없으면 chrome 높이만", () => {
    expect(cardHeight(concept())).toBe(CARD_CHROME_H);
  });

  it("줄마다 선형으로 늘어난다 (최대 클램프 없음)", () => {
    const long = cardHeight(concept({ blocks: [p("가".repeat(500))] }));
    const short = cardHeight(concept({ blocks: [p("가")] }));
    expect(long).toBeGreaterThan(short);
    // 사용자 결정 2026-07-23: 클램프를 두지 않는다 — 상한이 생기면 긴 카드가
    // 실제보다 작게 추정돼 겹친다.
    expect(long).toBe(CARD_CHROME_H + estimateBodyLines([p("가".repeat(500))]) * CARD_H_PER_LINE);
  });

  it("스트리밍 중(pending)에는 2줄을 예약한다", () => {
    expect(cardHeight(concept({ pending: true, blocks: [] })))
      .toBe(CARD_CHROME_H + CARD_STREAM_LINES * CARD_H_PER_LINE);
  });

  it("출처 칩이 있으면 그만큼 더 잡는다", () => {
    const base = cardHeight(concept({ blocks: [p("본문")] }), false);
    expect(cardHeight(concept({ blocks: [p("본문")] }), true)).toBe(base + SOURCES_EXTRA_H);
  });

  it("서버 저장 높이(h)가 있으면 그 값을 신뢰한다", () => {
    expect(cardHeight(concept({ h: 300, blocks: [p("가".repeat(500))] }))).toBe(300);
  });

  it("h가 0이거나 음수면 추정으로 되돌아간다", () => {
    // 0을 "저장된 값"으로 믿으면 카드가 높이 0으로 취급돼 전부 겹친다.
    expect(cardHeight(concept({ h: 0, blocks: [] }))).toBe(CARD_CHROME_H);
  });
});

describe("치수 SSOT", () => {
  it("중심 오프셋은 카드 폭의 절반", () => {
    expect(CARD_CX).toBe(CARD_W / 2);
  });
});
