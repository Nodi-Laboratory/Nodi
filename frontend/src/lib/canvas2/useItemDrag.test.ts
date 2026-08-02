import { describe, expect, it } from "vitest";
import { withSelf } from "./useItemDrag";

/**
 * `peerEls`의 순수 부분. DOM 조회(querySelectorAll)는 node 환경에서 못 돌리므로
 * (repo가 jsdom을 뒤로 미룬다), self 병합·중복 제거만 순수 함수로 검증한다.
 * 평범한 객체를 요소 대역으로 쓴다 — includes는 참조 동등성만 본다.
 */
const el = (name: string) => ({ name }) as unknown as HTMLElement;

describe("withSelf", () => {
  it("빈 선택에 self만 있으면 self 하나를 반환한다", () => {
    const self = el("a");
    expect(withSelf([], self)).toEqual([self]);
  });

  it("선택 목록에 self를 뒤에 더한다", () => {
    const a = el("a");
    const b = el("b");
    const out = withSelf([a, b], el("c"));
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it("self가 이미 선택 집합에 있으면 중복으로 넣지 않는다", () => {
    const a = el("a");
    const b = el("b");
    const out = withSelf([a, b], a);
    expect(out).toHaveLength(2);
    expect(out.filter((e) => e === a)).toHaveLength(1);
  });

  it("self가 null이면 선택 목록을 그대로(복사해) 돌려준다", () => {
    const a = el("a");
    const out = withSelf([a], null);
    expect(out).toEqual([a]);
  });
});
