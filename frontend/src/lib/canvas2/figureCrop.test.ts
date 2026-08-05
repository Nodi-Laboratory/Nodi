import { describe, expect, it } from "vitest";
import { containRect, worldToFigure } from "./figureCrop";

const BOX = { x: 100, y: 100, w: 200, h: 200 };

describe("containRect", () => {
  it("비율이 같으면 상자를 꽉 채운다", () => {
    expect(containRect(BOX, 400, 400)).toEqual(BOX);
  });

  it("세로로 긴 그림은 좌우에 띠가 생긴다", () => {
    // 200x400 그림 → 높이에 맞춰 100x200, 좌우 각 50
    expect(containRect(BOX, 200, 400)).toEqual({ x: 150, y: 100, w: 100, h: 200 });
  });

  it("가로로 긴 그림은 위아래에 띠가 생긴다", () => {
    expect(containRect(BOX, 400, 200)).toEqual({ x: 100, y: 150, w: 200, h: 100 });
  });

  it("자연 크기를 모르면 상자를 그대로 준다", () => {
    // 비트맵을 못 받았을 때 좌표를 0으로 나누지 않는다.
    expect(containRect(BOX, 0, 0)).toEqual(BOX);
  });
});

describe("worldToFigure", () => {
  it("꽉 찬 그림의 가운데는 그림의 가운데다", () => {
    expect(worldToFigure(200, 200, BOX, 400, 400)).toEqual({ x: 200, y: 200 });
  });

  /**
   * **이 테스트가 이 파일이 있는 이유다.** 레터박스를 무시하고 아이템 rect에
   * 그대로 매핑하면 동그라미가 그림의 엉뚱한 데 얹히는데, 결과물은
   * "그럴싸한 그림"이라 눈으로는 안 잡힌다.
   */
  it("세로로 긴 그림에서는 띠만큼 밀린다", () => {
    // 그려진 영역은 x 150~250. 그 왼쪽 끝이 그림의 x=0이다.
    expect(worldToFigure(150, 100, BOX, 200, 400)).toEqual({ x: 0, y: 0 });
    expect(worldToFigure(250, 300, BOX, 200, 400)).toEqual({ x: 200, y: 400 });
  });

  it("가로로 긴 그림에서도 띠만큼 밀린다", () => {
    // 그려진 영역은 y 150~250.
    expect(worldToFigure(100, 150, BOX, 400, 200)).toEqual({ x: 0, y: 0 });
    expect(worldToFigure(300, 250, BOX, 400, 200)).toEqual({ x: 400, y: 200 });
  });

  it("띠 위의 점은 그림 밖이다", () => {
    expect(worldToFigure(120, 200, BOX, 200, 400)).toBeNull();
  });

  it("상자 밖의 점도 그림 밖이다", () => {
    expect(worldToFigure(0, 0, BOX, 400, 400)).toBeNull();
  });
});
