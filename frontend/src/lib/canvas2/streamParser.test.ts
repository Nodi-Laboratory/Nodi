/**
 * 스트리밍 파서 v2 (D125).
 *
 * 가장 중요한 계약: **구 형식과 신 형식이 같은 결과로 수렴한다.** 저장된
 * 세션은 전부 `- ` 접두사 형식이라, 신 형식만 받으면 지난 대화가 빈 화면이 된다.
 *
 * 그리고 v1이 실측으로 얻은 관용성(줄 끝 종료 토큰 등)을 잃지 않았는지 —
 * 이걸 놓치면 제어 토큰이 학생 화면에 그대로 찍힌다.
 */

import { describe, expect, it } from "vitest";
import { appendLine, createStreamParser, type StreamEvent } from "./streamParser";
import { toBlocks, blocksToText } from "./markup";

/** 파서를 돌려 개념 목록으로 접는다 — 실제 소비자(useCanvasSession)와 같은 방식. */
function run(text: string, chunkSize = 0) {
  const events: StreamEvent[] = [];
  const p = createStreamParser((e) => events.push(e));
  if (chunkSize > 0) {
    for (let i = 0; i < text.length; i += chunkSize) {
      p.push(text.slice(i, i + chunkSize));
    }
  } else {
    p.push(text);
  }
  p.end();

  let reply = "";
  const concepts: { title: string; tag: string; body: string; related: string[] }[] = [];
  for (const e of events) {
    if (e.t === "reply") reply = e.text;
    if (e.t === "cstart") concepts.push({ title: e.title, tag: e.tag, body: "", related: [] });
    if (e.t === "body" && concepts.length) {
      const c = concepts[concepts.length - 1];
      c.body = appendLine(c.body, e.text);
    }
    if (e.t === "related" && concepts.length) {
      concepts[concepts.length - 1].related = e.titles;
    }
  }
  return { reply, concepts, events };
}

const NEW_FORMAT = `CHAT: 물의 순환을 살펴볼까요?
@concept: 물의 순환 | 지구과학
물은 태양 에너지를 받아 **증발**한다. 이때 액체가 기체로 바뀐다.

높이 올라간 수증기는 식으면서 ==응결==해 구름이 된다.
@related: 증발, 응결
@end`;

const OLD_FORMAT = `CHAT: 물의 순환을 살펴볼까요?
@concept: 물의 순환 | 지구과학
- 물은 태양 에너지를 받아 **증발**한다
- 수증기가 식으면 ==응결==해 구름이 된다
@related: 증발, 응결
@end`;

describe("형식 호환", () => {
  it("신 형식(문단)을 파싱한다", () => {
    const { reply, concepts } = run(NEW_FORMAT);
    expect(reply).toBe("물의 순환을 살펴볼까요?");
    expect(concepts).toHaveLength(1);
    expect(concepts[0].title).toBe("물의 순환");
    expect(concepts[0].tag).toBe("지구과학");
    expect(concepts[0].related).toEqual(["증발", "응결"]);
    // 문단 둘로 렌더돼야 한다
    expect(toBlocks(concepts[0].body).map((b) => b.type)).toEqual(["p", "p"]);
  });

  it("구 형식(- 접두)도 그대로 파싱한다", () => {
    const { concepts } = run(OLD_FORMAT);
    expect(concepts).toHaveLength(1);
    expect(toBlocks(concepts[0].body).map((b) => b.type)).toEqual(["li", "li"]);
  });

  it("본문에 마크업 원문이 보존된다 — 학생이 수정할 원본이다", () => {
    const { concepts } = run(NEW_FORMAT);
    expect(concepts[0].body).toContain("**증발**");
    expect(concepts[0].body).toContain("==응결==");
    // 렌더 시점에는 벗겨진다
    expect(blocksToText(toBlocks(concepts[0].body))).not.toContain("**");
  });
});

describe("스트리밍 분할에 무관하다", () => {
  it.each([1, 3, 7, 40])("청크 %i자로 쪼개도 결과가 같다", (n) => {
    const whole = run(NEW_FORMAT);
    const split = run(NEW_FORMAT, n);
    expect(split.concepts).toEqual(whole.concepts);
    expect(split.reply).toBe(whole.reply);
  });
});

describe("실측 하드닝 유지", () => {
  it.each(["@end", "/end", "[end]", "(end)", "END"])("종료 토큰 %s를 알아본다", (tok) => {
    const { concepts } = run(`@concept: 가 | 나\n본문\n${tok}\n뒤에 붙은 잡음`);
    expect(concepts[0].body).toBe("본문");
  });

  it("본문 줄 끝에 붙은 종료 토큰을 떼고 개념을 닫는다", () => {
    // 2026-07-27 학생 세션 실측: `- … 폭발을 일으켜요  /end`
    const { concepts } = run("@concept: 가 | 나\n큰 폭발을 일으켜요  /end\n다음 줄");
    expect(concepts[0].body).toBe("큰 폭발을 일으켜요");
  });

  it("end로 끝나는 정상 문장은 자르지 않는다", () => {
    const { concepts } = run("@concept: 가 | 나\nThis is the end\n@end");
    expect(concepts[0].body).toBe("This is the end");
  });

  it("분류는 | split의 두 번째다 — 정규식이 다음 줄을 삼키지 않는다", () => {
    const { concepts } = run("@concept: 제목 | 분류\n본문\n@end");
    expect(concepts[0].tag).toBe("분류");
    expect(concepts[0].body).toBe("본문");
  });

  it("분류가 없으면 빈 문자열", () => {
    expect(run("@concept: 제목만\n본문\n@end").concepts[0].tag).toBe("");
  });

  it("닫히지 않은 개념도 end()에서 닫힌다", () => {
    const { concepts, events } = run("@concept: 가 | 나\n본문");
    expect(concepts[0].body).toBe("본문");
    expect(events.filter((e) => e.t === "cend")).toHaveLength(1);
  });

  it("다음 @concept가 앞 개념을 자동으로 닫는다", () => {
    const { concepts } = run("@concept: 1 | t\n가\n@concept: 2 | t\n나\n@end");
    expect(concepts.map((c) => [c.title, c.body])).toEqual([
      ["1", "가"],
      ["2", "나"],
    ]);
  });
});

describe("문단 경계", () => {
  it("개념 시작 직후의 빈 줄은 버린다", () => {
    // 모델이 @concept: 다음에 한 줄 띄우는 일이 흔하다. 그대로 두면 본문이
    // 빈 문단으로 시작해 첫 문단 위에 공백이 뜬다.
    const { concepts } = run("@concept: 가 | 나\n\n\n첫 문단\n@end");
    expect(concepts[0].body).toBe("첫 문단");
  });

  it("문단 사이 빈 줄은 보존한다", () => {
    const { concepts } = run("@concept: 가 | 나\n첫째\n\n둘째\n@end");
    expect(concepts[0].body).toBe("첫째\n\n둘째");
    expect(toBlocks(concepts[0].body)).toHaveLength(2);
  });
});

describe("경계", () => {
  it("개념이 없으면 말풍선만", () => {
    const { reply, concepts } = run("CHAT: 안녕하세요!");
    expect(reply).toBe("안녕하세요!");
    expect(concepts).toEqual([]);
  });

  it("개념 밖의 줄은 조용히 버린다", () => {
    expect(run("잡담 한 줄\n@concept: 가 | 나\n본문\n@end").concepts[0].body).toBe("본문");
  });

  it("빈 입력에도 done을 낸다", () => {
    const { events } = run("");
    expect(events.at(-1)).toEqual({ t: "done" });
  });
});

describe("머리표를 빠뜨린 답 되살리기 (2026-08-07 실측)", () => {
  /**
   * 모델은 `@concept:`를 **가끔 통째로 빠뜨린다** — 실측 18턴 중 4턴(22%),
   * 특히 이어 묻는 턴에서 몰려 났다. 그때 답이 통째로 사라졌다: 토큰은 다
   * 왔는데 화면에는 아무것도 안 뜨고 오류도 로그도 없었다.
   */
  const 실제_누락_답 =
    "광합성은 식물이 **에너지**를 만들기 위해 꼭 필요한 과정이에요. " +
    "==광합성==이 없으면 식물은 스스로 영양분을 만들 수 없어요.\n\n" +
    "햇빛을 받아 **이산화탄소**와 **물**을 **포도당**으로 바꾸는 이 작용은 " +
    "==생명 유지==의 기본이 됩니다.\n@end";

  it("머리표가 없어도 카드가 생긴다", () => {
    const { concepts } = run(실제_누락_답);
    expect(concepts).toHaveLength(1);
    expect(concepts[0].body).toContain("광합성은 식물이");
    expect(concepts[0].body).toContain("생명 유지");
  });

  it("제목은 첫 굵은 낱말에서 빌린다", () => {
    const { concepts } = run(실제_누락_답);
    expect(concepts[0].title).toBe("에너지");
  });

  it("종료 토큰은 본문에 남지 않는다", () => {
    const { concepts } = run(실제_누락_답);
    expect(concepts[0].body).not.toContain("@end");
  });

  it("CHAT 한 줄짜리 인사 턴은 그대로 카드가 없다", () => {
    // 되살리기가 인사까지 카드로 만들면 캔버스가 지저분해진다.
    const { reply, concepts } = run("CHAT: 안녕하세요! 무엇이 궁금한가요?");
    expect(reply).toBe("안녕하세요! 무엇이 궁금한가요?");
    expect(concepts).toEqual([]);
  });

  it("짧은 군더더기는 살리지 않는다", () => {
    expect(run("네, 알겠어요.").concepts).toEqual([]);
  });

  it("카드가 이미 있으면 그 사이 잡담은 그대로 버린다", () => {
    // 살리면 한 턴에 카드가 둘 생겨 "한 턴 한 노드"(D162)가 깨진다.
    const { concepts } = run(
      "@concept: 가 | 나\n본문\n@end\n" +
        "여기부터는 개념 밖의 긴 잡담입니다. 마흔 자를 넘기려고 일부러 길게 씁니다.",
    );
    expect(concepts).toHaveLength(1);
    expect(concepts[0].body).toBe("본문");
  });
});
