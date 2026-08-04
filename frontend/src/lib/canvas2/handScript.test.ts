import { describe, expect, it } from "vitest";
import { toScriptSegs, tuneOf } from "./handScript";

describe("tuneOf", () => {
  it("한자·가나를 고른다", () => {
    for (const ch of "漢字語文山あいうカナ") {
      expect(tuneOf(ch.codePointAt(0)!), ch).toBe("cjk");
    }
  });

  it("손글씨 폰트가 덮는 글자는 건드리지 않는다", () => {
    // hand-font.css가 실제로 싣는 것 — 한글 음절·아스키·호환 자모
    for (const ch of "한글빛물ABCxyz0123 .,?!ㄱㄴㅏㅣ") {
      expect(tuneOf(ch.codePointAt(0)!), ch).toBeNull();
    }
  });

  it("폴백이지만 배율로 못 맞추는 부류는 두고 본다", () => {
    // 그리스·키릴·수학기호는 실측상 오차가 작고 대문자/소문자 비율이 달라
    // 배율 하나로 맞출 수 없다(handScript.ts 주석 참조).
    for (const ch of "αβγΩАБВ±×÷≈∑√°½") {
      expect(tuneOf(ch.codePointAt(0)!), ch).toBeNull();
    }
  });

  it("한글 호환 자모가 CJK 범위에 걸리지 않는다", () => {
    for (let cp = 0x3131; cp <= 0x3163; cp++) expect(tuneOf(cp)).toBeNull();
  });
});

describe("toScriptSegs", () => {
  it("보정할 글자가 없으면 구간 하나다 — 호출부가 span을 더 만들지 않는 조건", () => {
    expect(toScriptSegs("빛에너지를 받아 포도당을 만든다")).toEqual([
      { text: "빛에너지를 받아 포도당을 만든다", script: null, at: 0 },
    ]);
  });

  it("빈 문자열은 구간이 없다", () => {
    expect(toScriptSegs("")).toEqual([]);
  });

  it("같은 부류가 이어지면 한 구간으로 합친다", () => {
    expect(toScriptSegs("광합성(光合成)이란")).toEqual([
      { text: "광합성(", script: null, at: 0 },
      { text: "光合成", script: "cjk", at: 4 },
      { text: ")이란", script: null, at: 7 },
    ]);
  });

  it("쪼개도 글자는 하나도 잃지 않는다", () => {
    const src = "물 水 と 火 fire 불";
    expect(toScriptSegs(src).map((s) => s.text).join("")).toBe(src);
  });

  it("서로게이트 쌍을 반으로 가르지 않는다", () => {
    // U+20000 (CJK 확장 B) — 코드 유닛으로 자르면 깨진 글자가 span 둘로 갈린다
    const ext = String.fromCodePoint(0x20000);
    const segs = toScriptSegs(`한${ext}글`);
    expect(segs).toEqual([
      { text: "한", script: null, at: 0 },
      { text: ext, script: "cjk", at: 1 },
      // 서로게이트 쌍이 코드 유닛 둘을 먹으므로 다음 구간은 3에서 시작한다
      { text: "글", script: null, at: 3 },
    ]);
    expect(segs[1]!.text.length).toBe(2);
  });
});
