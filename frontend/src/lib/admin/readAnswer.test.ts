import { describe, expect, it } from "vitest";
import { readAnswer } from "./readAnswer";

/**
 * 관리자 콘솔의 답변 박스 (사용자 보고 2026-08-10).
 *
 * `ai_logs.answer`는 **전선 위 원문**이라 `CHAT:`·`@concept:`가 섞여 있다.
 * 그걸 그대로 박스에 넣으면 운영자 눈에는 "응답에 다른 내용이 들어간" 것으로
 * 보인다. 답이 이상한 게 아니라 보여 주는 방식이 이상했던 것이다.
 */
describe("readAnswer", () => {
  const 실제 = [
    "CHAT: 무지개는 햇빛과 물방울이 만나 만들어 내는 아름다운 빛줄기예요.",
    "",
    "@concept: 무지개 | 빛의 분산과 굴절",
    "무지개는 **햇빛**이 공기 중의 **물방울**에 들어가서 꺾이고 다시 나올 때 생겨요.",
    "파장이 짧은 색은 더 많이 꺾입니다.",
  ].join("\n");

  it("말풍선과 카드를 갈라 낸다", () => {
    const r = readAnswer(실제);
    expect(r.reply).toBe("무지개는 햇빛과 물방울이 만나 만들어 내는 아름다운 빛줄기예요.");
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0].title).toBe("무지개");
    expect(r.cards[0].tag).toBe("빛의 분산과 굴절");
    expect(r.cards[0].body).toContain("햇빛");
  });

  it("프로토콜 표시가 본문에 남지 않는다", () => {
    const r = readAnswer(실제);
    const 합 = r.reply + r.cards.map((c) => c.body).join("");
    expect(합).not.toContain("CHAT:");
    expect(합).not.toContain("@concept:");
  });

  it("카드가 여럿이면 여럿으로 나온다", () => {
    const r = readAnswer(
      [
        "CHAT: 두 가지를 볼게요.",
        "@concept: 굴절 | 빛",
        "굴절 설명.",
        "@concept: 반사 | 빛",
        "반사 설명.",
      ].join("\n"),
    );
    expect(r.cards.map((c) => c.title)).toEqual(["굴절", "반사"]);
    expect(r.cards[1].body).toContain("반사 설명");
  });

  it("빈 입력에도 안 터진다", () => {
    for (const v of [null, undefined, "", "   "]) {
      const r = readAnswer(v);
      expect(r.reply).toBe("");
      expect(r.cards).toEqual([]);
    }
  });

  it("형식이 아예 다르면 원문을 통째로 넘긴다", () => {
    // 관리자 콘솔은 **무엇이 잘못됐는지 보러 오는 곳**이다 — 못 읽겠다고
    // 빈 화면을 주면 정작 봐야 할 것을 못 본다.
    const r = readAnswer("그냥 평범한 한 줄짜리 답입니다.");
    expect(r.rest).toBe("그냥 평범한 한 줄짜리 답입니다.");
  });
});
