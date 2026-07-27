import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { shouldRetry } from "@/lib/retryPolicy";

/**
 * react-query 재시도 정책 회귀 (D105).
 *
 * 기본값(retry: 3)이 4xx에도 걸려 있어서, 프로필 없는 사용자의 `/auth/me` 404가
 * 요청 4번으로 불어났다(실측 2026-07-27). 정책을 되돌리면 로그가 다시 지저분해지고
 * 오류 표시도 늦어지므로, 계약을 여기서 고정한다.
 */
describe("재시도 정책", () => {
  it.each([400, 401, 403, 404, 409, 422])("%d 는 재시도하지 않는다", (status) => {
    expect(shouldRetry(0, new ApiError(status, "nope"))).toBe(false);
  });

  it.each([408, 429])("%d 는 시간이 지나면 성공할 수 있으므로 재시도한다", (status) => {
    expect(shouldRetry(0, new ApiError(status, "later"))).toBe(true);
  });

  it.each([500, 502, 503])("%d 는 재시도한다", (status) => {
    expect(shouldRetry(0, new ApiError(status, "boom"))).toBe(true);
  });

  it("ApiError가 아닌 오류(네트워크 단절 등)도 재시도한다", () => {
    expect(shouldRetry(0, new TypeError("Failed to fetch"))).toBe(true);
  });

  it("3회까지만 재시도한다", () => {
    const err = new Error("network");
    expect(shouldRetry(2, err)).toBe(true);
    expect(shouldRetry(3, err)).toBe(false);
  });
});
