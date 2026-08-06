import { describe, expect, it } from "vitest";
import { pickThumbId } from "./clipThumb";

/**
 * 클립 썸네일 고르기 (D190).
 *
 * "랜덤"이라고 했지만 **매번 같아야** 한다는 것이 여기서 지키는 전부다.
 * 볼 때마다 다른 그림이면 학생이 어제 본 카드를 못 알아본다.
 */
describe("pickThumbId", () => {
  const thumbs = ["a", "b", "c", "d"];

  it("같은 클립은 언제나 같은 그림", () => {
    expect(pickThumbId("clip-1", thumbs)).toBe(pickThumbId("clip-1", thumbs));
  });

  it("**목록 순서가 바뀌어도** 같은 그림", () => {
    // 관리자가 그림을 한 장 올리면 최신순이라 목록 앞이 밀린다. 위치로
    // 고르면 그 순간 학생들의 카드가 전부 다른 그림으로 바뀐다.
    const shuffled = ["d", "b", "a", "c"];
    expect(pickThumbId("clip-1", shuffled)).toBe(pickThumbId("clip-1", thumbs));
  });

  it("클립마다 골고루 흩어진다", () => {
    const picked = new Set(
      Array.from({ length: 40 }, (_, i) => pickThumbId(`clip-${i}`, thumbs)),
    );
    // 넷을 다 쓰지 않으면 "여러 장 중 랜덤"이라는 말이 거짓이 된다.
    expect(picked.size).toBe(4);
  });

  it("고른 것은 반드시 목록 안에 있다", () => {
    for (let i = 0; i < 20; i++) {
      expect(thumbs).toContain(pickThumbId(`clip-${i}`, thumbs));
    }
  });

  it("올라온 그림이 없으면 null — 깨진 이미지 대신 아무것도 안 그린다", () => {
    expect(pickThumbId("clip-1", [])).toBeNull();
  });

  it("한 장뿐이면 그것만", () => {
    expect(pickThumbId("무엇이든", ["only"])).toBe("only");
  });
});
