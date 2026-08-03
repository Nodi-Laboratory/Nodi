import { describe, it, expect } from "vitest";
import { clipToItemData } from "./clipMap";

describe("clipToItemData", () => {
  it("maps snake_case event to camelCase clip data", () => {
    const d = clipToItemData({
      clip_id: "c1", title: "고려 토지제도", start_sec: 896,
      timeline_label: "14:56", page_url: "http://ebs/x", video_title: "04강", score: 0.7,
    });
    expect(d.clip?.clipId).toBe("c1");
    expect(d.clip?.timelineLabel).toBe("14:56");
    expect(d.clip?.pageUrl).toBe("http://ebs/x");
  });
});
