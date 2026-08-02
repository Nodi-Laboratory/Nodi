import { describe, expect, it } from "vitest";
import { figureDataForSave } from "./figureData";
import type { ItemData } from "./types";

describe("figureDataForSave — D87 url 제거", () => {
  it("figure.url을 빈 문자열로 비운다", () => {
    const data: ItemData = {
      figure: { figureId: "f1", fileId: "x", page: 3, caption: "c", url: "https://signed/abc" },
    };
    const out = figureDataForSave(data);
    expect(out.figure?.url).toBe("");
  });

  it("원본을 변형하지 않는다(불변)", () => {
    const data: ItemData = {
      figure: { figureId: "f1", fileId: "x", page: 3, caption: "c", url: "https://signed/abc" },
    };
    figureDataForSave(data);
    expect(data.figure?.url).toBe("https://signed/abc");
  });

  it("size 등 다른 필드는 보존한다", () => {
    const data: ItemData = {
      figure: { figureId: "f1", fileId: "x", page: 3, caption: "c", url: "u" },
      size: { w: 200, h: 140 },
    };
    const out = figureDataForSave(data);
    expect(out.size).toEqual({ w: 200, h: 140 });
  });

  it("figure가 없으면 원본을 그대로 돌려준다", () => {
    const data: ItemData = { size: { w: 100, h: 80 } };
    expect(figureDataForSave(data)).toBe(data);
  });
});
