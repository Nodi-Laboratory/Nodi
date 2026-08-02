import { describe, expect, it } from "vitest";
import { drainPending } from "./pendingPatches";
import type { ItemPatch } from "@/lib/api/canvas";

const P = (x: number): ItemPatch => ({ x, y: 0, pinned: true });
const UUID = "11111111-1111-1111-1111-111111111111";

describe("drainPending — 임시 id 버퍼를 진짜 id로 흘린다", () => {
  it("버퍼된 임시 id를 매칭되는 진짜 id로 보낼 목록을 낸다", () => {
    const buffer = new Map<string, ItemPatch>([["tmp-3", P(10)]]);
    const sends = drainPending(["tmp-3"], [UUID], buffer);
    expect(sends).toEqual([{ id: UUID, patch: P(10) }]);
  });

  it("흘린 항목은 버퍼에서 지운다", () => {
    const buffer = new Map<string, ItemPatch>([["tmp-3", P(10)]]);
    drainPending(["tmp-3"], [UUID], buffer);
    expect(buffer.has("tmp-3")).toBe(false);
  });

  it("버퍼에 없는 임시 id는 건너뛴다", () => {
    const buffer = new Map<string, ItemPatch>();
    const sends = drainPending(["tmp-3"], [UUID], buffer);
    expect(sends).toEqual([]);
  });

  it("대응하는 저장분이 진짜 id가 아니면 보내지 않는다(하지만 버퍼는 비운다)", () => {
    const buffer = new Map<string, ItemPatch>([["tmp-3", P(10)]]);
    const sends = drainPending(["tmp-3"], [null], buffer);
    expect(sends).toEqual([]);
    expect(buffer.has("tmp-3")).toBe(false);
  });

  it("여러 임시 id 중 버퍼된 것만 보낸다", () => {
    const other = "22222222-2222-2222-2222-222222222222";
    const buffer = new Map<string, ItemPatch>([["tmp-2", P(5)]]);
    const sends = drainPending(["tmp-1", "tmp-2"], [UUID, other], buffer);
    expect(sends).toEqual([{ id: other, patch: P(5) }]);
  });
});
