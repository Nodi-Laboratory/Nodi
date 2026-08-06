import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { uploadErrorMessage } from "./MaterialsTab";

/**
 * 업로드 실패 문구 (D188).
 *
 * 교사가 보는 마지막 한 줄이다. **무엇을 해야 하는지 모르는 문구는 없는 것과
 * 같다** — `HTTP 413`이나 `Failed to fetch`가 그랬다.
 */
describe("uploadErrorMessage", () => {
  it("서버가 준 한국어 사유는 그대로 쓴다", () => {
    const msg = uploadErrorMessage(
      new ApiError(413, "파일이 너무 큽니다(60MB). 50MB까지 올릴 수 있습니다."),
    );
    expect(msg).toContain("50MB까지");
  });

  it("사유 없는 413은 중간 구간이 거절한 것이라고 말한다", () => {
    // 엣지(CDN·프록시)가 거절하면 본문이 HTML이라 `HTTP 413`만 남는다.
    const msg = uploadErrorMessage(new ApiError(413, "HTTP 413"));
    expect(msg).not.toContain("HTTP 413");
    expect(msg).toMatch(/나눠|관리자/);
  });

  it("503은 관리자 설정을 가리킨다", () => {
    expect(uploadErrorMessage(new ApiError(503, "HTTP 503"))).toContain("관리자");
  });

  it("연결이 끊기면 인터넷 탓으로 보이게 두지 않는다", () => {
    const msg = uploadErrorMessage(new TypeError("Failed to fetch"));
    expect(msg).not.toContain("Failed to fetch");
    expect(msg).toMatch(/끊겼|다시 시도/);
  });

  it("모르는 오류는 그래도 사유를 보여 준다", () => {
    // 숨기면 원인을 찾을 실마리가 사라진다.
    expect(uploadErrorMessage(new Error("이상한 일"))).toContain("이상한 일");
  });
});
