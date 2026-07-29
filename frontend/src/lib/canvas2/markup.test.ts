/**
 * 본문 렌더 변환 (D125).
 *
 * 가장 중요한 계약: **구 형식과 신 형식이 둘 다 살아야 한다.** 이미 저장된
 * 세션은 전부 `- ` 접두사 형식이라, 신 형식만 받으면 지난 대화가 통째로
 * 빈 화면이 된다.
 */

import { describe, expect, it } from "vitest";
import { blocksToText, toBlocks, toRuns } from "./markup";

const text = (b: ReturnType<typeof toBlocks>) => blocksToText(b);

describe("두 형식 호환", () => {
  it("구 형식(- 접두)은 목록으로", () => {
    const b = toBlocks("- 물은 증발한다\n- 구름이 된다");
    expect(b.map((x) => x.type)).toEqual(["li", "li"]);
    expect(text(b)).toBe("물은 증발한다\n구름이 된다");
  });

  it("신 형식(문단)은 문단으로", () => {
    const b = toBlocks("물은 증발한다.\n\n구름이 된다.");
    expect(b.map((x) => x.type)).toEqual(["p", "p"]);
    expect(text(b)).toBe("물은 증발한다.\n구름이 된다.");
  });

  it("한 문단 안의 줄바꿈은 공백으로 잇는다", () => {
    // 모델이 임의로 넣은 줄바꿈이 그대로 렌더되면 460px 폭에서 들쭉날쭉해진다.
    const b = toBlocks("물은 증발하고\n구름이 된다.");
    expect(b).toHaveLength(1);
    expect(text(b)).toBe("물은 증발하고 구름이 된다.");
  });

  it("섞여 있어도 각각 처리한다", () => {
    const b = toBlocks("도입 문단.\n\n- 항목 하나\n- 항목 둘\n\n마무리 문단.");
    expect(b.map((x) => x.type)).toEqual(["p", "li", "li", "p"]);
  });

  it("*, • 접두사도 목록으로 받는다", () => {
    expect(toBlocks("* 별\n• 점").map((x) => x.type)).toEqual(["li", "li"]);
  });
});

describe("마크업", () => {
  it("굵게·형광펜을 상태로 옮기고 마커는 지운다", () => {
    const [b] = toBlocks("**증발**은 ==상태 변화==다");
    expect(text([b])).toBe("증발은 상태 변화다");
    const runs = toRuns(b.tokens);
    expect(runs.find((r) => r.b)?.text).toBe("증발");
    expect(runs.find((r) => r.h)?.text).toBe("상태 변화");
  });

  it("짝이 안 맞는 마커에도 본문이 사라지지 않는다", () => {
    // 모델이 흔히 흘린다. 정규식으로 처리하면 여기서 본문이 통째로 날아간다.
    expect(text(toBlocks("**닫히지 않은 굵게"))).toBe("닫히지 않은 굵게");
    expect(text(toBlocks("==열린 형광펜 그리고 **굵게"))).toBe(
      "열린 형광펜 그리고 굵게",
    );
  });

  it("런을 병합해 글자당 span을 만들지 않는다", () => {
    const [b] = toBlocks("보통 **굵게굵게** 보통");
    const runs = toRuns(b.tokens);
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.text)).toEqual(["보통 ", "굵게굵게", " 보통"]);
  });
});

describe("경계", () => {
  it("빈 본문은 빈 배열", () => {
    expect(toBlocks("")).toEqual([]);
    expect(toBlocks("\n\n   \n")).toEqual([]);
  });

  it("목록 기호만 있는 줄은 버린다", () => {
    expect(toBlocks("- \n-")).toEqual([]);
  });

  it("아주 긴 본문도 블록 수가 문단 수와 같다", () => {
    const body = Array.from({ length: 40 }, (_, i) => `문단 ${i}.`).join("\n\n");
    expect(toBlocks(body)).toHaveLength(40);
  });
});
