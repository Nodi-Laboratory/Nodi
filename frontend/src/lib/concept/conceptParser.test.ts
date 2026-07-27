import { describe, expect, it } from "vitest";
import { createConceptParser } from "./conceptParser";
import type { ParserEvent } from "./types";

/**
 * 스트림 파서 회귀 (D105).
 *
 * 이 파서가 틀리면 **모델이 낸 제어 토큰이 학생 화면에 그대로 찍힌다.**
 * 실제로 두 번 일어났다(2026-07-27): 본문 끝의 `/end`, 말풍선의 `==강조==`.
 * 둘 다 타입은 멀쩡했으므로 tsc·build 스모크로는 잡히지 않았다.
 */

interface Parsed {
  chat: string;
  concepts: Array<{ title: string; cluster: string }>;
  bodies: string[];
  related: string[][];
  cends: number;
}

/** 스트림 텍스트를 파서에 통과시켜 화면에 도달하는 값만 뽑는다. */
function parse(text: string, chunkSize = 0): Parsed {
  const evs: ParserEvent[] = [];
  const p = createConceptParser((e) => evs.push(e));
  if (chunkSize > 0) {
    // 토큰이 쪼개져 도착하는 실제 SSE 상황 재현.
    for (let i = 0; i < text.length; i += chunkSize) {
      p.push(text.slice(i, i + chunkSize));
    }
  } else {
    p.push(text);
  }
  p.end();

  const out: Parsed = { chat: "", concepts: [], bodies: [], related: [], cends: 0 };
  let cur: string | null = null;
  for (const e of evs) {
    if (e.t === "reply") out.chat += e.ch;
    else if (e.t === "cstart") out.concepts.push(e.concept);
    else if (e.t === "bstart") cur = "";
    else if (e.t === "delta" && cur !== null) cur += e.ch;
    else if (e.t === "bend") {
      out.bodies.push(cur ?? "");
      cur = null;
    } else if (e.t === "related") out.related.push(e.titles);
    else if (e.t === "cend") out.cends += 1;
  }
  return out;
}

const WELL_FORMED = [
  "CHAT: 화산이 폭발하는 이유를 알려줄게요",
  "@concept: 화산 폭발의 원인 | 화산 활동",
  "- 지구 내부의 **마그마**가 올라와요",
  "- 압력이 커지면 ==폭발==해요",
  "@related: 마그마, 판 구조론",
  "@end",
].join("\n");

describe("정상 형식", () => {
  it("말풍선·개념·본문·관련·종료를 모두 뽑는다", () => {
    const r = parse(WELL_FORMED);
    expect(r.chat).toBe("화산이 폭발하는 이유를 알려줄게요");
    expect(r.concepts).toEqual([{ title: "화산 폭발의 원인", cluster: "화산 활동" }]);
    expect(r.bodies).toEqual([
      "지구 내부의 마그마가 올라와요",
      "압력이 커지면 폭발해요",
    ]);
    expect(r.related).toEqual([["마그마", "판 구조론"]]);
    expect(r.cends).toBe(1);
  });

  it("토큰이 1글자씩 쪼개져 와도 결과가 같다", () => {
    // SSE는 줄 단위로 오지 않는다 — 증분 파서의 핵심 계약.
    expect(parse(WELL_FORMED, 1)).toEqual(parse(WELL_FORMED));
  });

  it("분류가 없으면 cluster는 빈 문자열", () => {
    const r = parse("@concept: 제목만\n- 본문\n@end");
    expect(r.concepts[0]).toEqual({ title: "제목만", cluster: "" });
  });

  it("개념이 안 닫혀도 스트림 종료 시 닫는다", () => {
    const r = parse("@concept: 미완 | 태그\n- 본문");
    expect(r.cends).toBe(1);
    expect(r.bodies).toEqual(["본문"]);
  });

  it("다음 @concept이 앞 개념을 자동으로 닫는다", () => {
    const r = parse("@concept: a | t\n- 하나\n@concept: b | t\n- 둘\n@end");
    expect(r.concepts).toHaveLength(2);
    expect(r.cends).toBe(2);
  });

  it("개념 밖의 본문 줄은 버린다", () => {
    // cstart 전에 온 `- ` 줄이 첫 카드에 섞이면 안 된다.
    expect(parse("- 떠도는 줄\n@concept: a | t\n- 진짜 본문\n@end").bodies)
      .toEqual(["진짜 본문"]);
  });
});

describe("종료 토큰 변형 (2026-07-27 실측 회귀)", () => {
  it("본문 꼬리에 붙은 /end를 지우고 그 자리에서 개념을 닫는다", () => {
    // DB에 남은 실제 스트림: `- … 폭발을 일으켜요  /end` 다음 줄에 `@end`.
    const r = parse("@concept: 화산 | 화산 활동\n- 가스가 팽창해요  /end\n@end");
    expect(r.bodies).toEqual(["가스가 팽창해요"]);
    expect(r.cends).toBe(1); // closeConcept 멱등 — 뒤의 @end가 두 번 닫지 않는다
  });

  it.each(["/end", "[end]", "(end)", "\\end", "@end"])(
    "종료 줄 표기 %s 를 인식한다",
    (token) => {
      const r = parse(`@concept: a | t\n- 본문\n${token}`);
      expect(r.bodies).toEqual(["본문"]);
      expect(r.cends).toBe(1);
    },
  );

  it("end로 끝나는 정상 문장은 자르지 않는다", () => {
    expect(parse("@concept: a | t\n- happy end\n@end").bodies).toEqual(["happy end"]);
  });
});

describe("강조 마커", () => {
  it("말풍선에서도 마커를 걷어낸다", () => {
    // 본문만 처리하고 CHAT 줄은 흘려보내던 버그 — 화면에 ==광합성==이 찍혔다.
    const r = parse("CHAT: 과정을 알려줄게==광합성==이야.");
    expect(r.chat).toBe("과정을 알려줄게광합성이야.");
  });

  it("본문의 굵게·형광펜 플래그를 글자에 싣는다", () => {
    const evs: ParserEvent[] = [];
    const p = createConceptParser((e) => evs.push(e));
    p.push("@concept: a | t\n- **굵게** 와 ==형광==\n@end");
    p.end();
    const bold = evs.filter((e) => e.t === "delta" && e.b).map((e) => (e as { ch: string }).ch);
    const hi = evs.filter((e) => e.t === "delta" && e.h).map((e) => (e as { ch: string }).ch);
    expect(bold.join("")).toBe("굵게");
    expect(hi.join("")).toBe("형광");
  });

  it("홀로 남은 = 는 글자로 살아남는다", () => {
    // 1+1=2 가 1+12 가 되면 안 된다.
    expect(parse("CHAT: 1+1=2 야").chat).toBe("1+1=2 야");
  });

  it("겹친 마커도 처리한다", () => {
    expect(parse("@concept: a | t\n- **==둘 다==**\n@end").bodies).toEqual(["둘 다"]);
  });
});

describe("형식 밖 입력", () => {
  it("인사만 있는 답(개념 0개)도 깨지지 않는다", () => {
    const r = parse("CHAT: 안녕! 무엇이 궁금해?");
    expect(r.concepts).toHaveLength(0);
    expect(r.cends).toBe(0);
  });

  it("빈 스트림은 아무 것도 만들지 않는다", () => {
    const r = parse("");
    expect(r).toEqual({ chat: "", concepts: [], bodies: [], related: [], cends: 0 });
  });

  it("알 수 없는 줄은 조용히 버린다", () => {
    expect(parse("@concept: a | t\n> 인용\n무접두사 줄\n- 본문\n@end").bodies)
      .toEqual(["본문"]);
  });

  it("개념 밖 @related는 무시한다", () => {
    expect(parse("@related: a, b").related).toEqual([]);
  });
});
