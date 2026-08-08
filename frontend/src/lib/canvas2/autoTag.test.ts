/** 떼어낸 묶음의 자동 분류 (D211 10). */

import { describe, expect, it } from "vitest";
import { autoTagFor } from "./autoTag";

describe("자동 분류", () => {
  it("두 장 이상이면 뿌리 제목을 쓴다", () => {
    expect(autoTagFor({ rootTitle: "맨틀 대류", groupSize: 3, taken: [] })).toBe("맨틀 대류");
  });

  it("한 장이면 분류 없음이다", () => {
    /** 카드 한 장은 아직 "다른 갈래"가 아니라 그냥 옮긴 카드다. */
    expect(autoTagFor({ rootTitle: "맨틀 대류", groupSize: 1, taken: [] })).toBeNull();
  });

  it("제목이 없으면 지어내지 않는다", () => {
    expect(autoTagFor({ rootTitle: "", groupSize: 3, taken: [] })).toBeNull();
    expect(autoTagFor({ rootTitle: null, groupSize: 3, taken: [] })).toBeNull();
  });

  it("이미 있는 이름과 겹치지 않는다", () => {
    /**
     * 겹치면 열이 하나로 합쳐져, 학생이 방금 떼어낸 것이 **원래 자리로 돌아간
     * 것처럼** 보인다.
     */
    const t = autoTagFor({ rootTitle: "맨틀 대류", groupSize: 2, taken: ["맨틀 대류"] });
    expect(t).not.toBe("맨틀 대류");
    expect(t).toContain("맨틀 대류");
  });

  it("여러 번 떼어내도 계속 새 이름이 나온다", () => {
    const taken = ["맨틀 대류", "맨틀 대류 2"];
    expect(autoTagFor({ rootTitle: "맨틀 대류", groupSize: 2, taken })).toBe("맨틀 대류 3");
  });

  it("열 라벨이 무너지지 않게 길이를 자른다", () => {
    const t = autoTagFor({ rootTitle: "아주아주아주아주아주아주긴제목입니다", groupSize: 2, taken: [] });
    expect(t!.length).toBeLessThanOrEqual(16);
  });
});
