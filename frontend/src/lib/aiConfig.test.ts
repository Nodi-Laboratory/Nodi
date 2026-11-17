/**
 * AI 준비 상태 조합표 (Gemini 단일 키, 2026-11-17).
 *
 * 서버 .env 키 x 브라우저 키 x 업로드 플래그의 조합에서 "무엇이 잠기고 입력 UI가
 * 뜨는가"를 고정한다. 대화·비전은 같은 키라 늘 같이 움직여야 하고, 업로드는
 * 방문자 키와 무관해야 한다(워커가 헤더를 못 본다).
 */
import { describe, expect, it } from "vitest";
import { deriveAiReadiness, type PublicConfig } from "./aiConfig";

const cfg = (over: Partial<PublicConfig> = {}): PublicConfig => ({
  upstage_key_configured: false,
  gemini_key_configured: false,
  upload_enabled: false,
  ...over,
});

describe("deriveAiReadiness", () => {
  it("조회 전에는 아무것도 잠그지 않고 입력 UI도 안 띄운다", () => {
    expect(deriveAiReadiness(null, false)).toMatchObject({
      loaded: false,
      chatReady: true,
      visionReady: true,
      uploadEnabled: true,
      needsGeminiInput: false,
      needsUpstageInput: false,
    });
  });

  it("서버·브라우저 모두 키가 없으면 AI가 잠기고 입력을 요구한다", () => {
    expect(deriveAiReadiness(cfg(), false)).toMatchObject({
      loaded: true,
      chatReady: false,
      visionReady: false,
      needsGeminiInput: true,
    });
  });

  it("브라우저에 Gemini 키가 있으면 대화·비전이 함께 열린다(입력 UI는 계속 가능)", () => {
    expect(deriveAiReadiness(cfg(), true)).toMatchObject({
      chatReady: true,
      visionReady: true,
      needsGeminiInput: true,
    });
  });

  it("서버에 Gemini 키가 있으면 열리고 입력 UI는 뜨지 않는다", () => {
    expect(deriveAiReadiness(cfg({ gemini_key_configured: true }), false)).toMatchObject({
      chatReady: true,
      visionReady: true,
      needsGeminiInput: false,
    });
  });

  it("서버 Upstage 키만 있어도 AI는 열리지 않는다(문서 파싱 전용)", () => {
    expect(deriveAiReadiness(cfg({ upstage_key_configured: true }), false)).toMatchObject({
      chatReady: false,
      visionReady: false,
      needsGeminiInput: true,
    });
  });

  it("Upstage 입력은 어떤 조합에서도 요구하지 않는다", () => {
    for (const up of [true, false])
      for (const g of [true, false])
        for (const b of [true, false])
          expect(
            deriveAiReadiness(cfg({ upstage_key_configured: up, gemini_key_configured: g }), b)
              .needsUpstageInput,
          ).toBe(false);
  });

  it("chatReady와 visionReady는 늘 같다", () => {
    for (const g of [true, false])
      for (const b of [true, false]) {
        const r = deriveAiReadiness(cfg({ gemini_key_configured: g }), b);
        expect(r.chatReady).toBe(r.visionReady);
      }
  });

  it("업로드는 서버 플래그만 따르고 브라우저 Gemini 키로 열리지 않는다", () => {
    expect(deriveAiReadiness(cfg({ upload_enabled: false }), true).uploadEnabled).toBe(false);
    expect(deriveAiReadiness(cfg({ upload_enabled: true }), false).uploadEnabled).toBe(true);
  });
});
