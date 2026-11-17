"use client";

/**
 * AI 기능이 지금 쓸 수 있는가 (공개판 C 분류, 2026-09-27; Gemini 단일 키 2026-11-17).
 *
 * 두 출처를 합친다:
 *   - 서버 `.env`에 Gemini 키가 있나 — `GET /api/config`(true/false만 온다)
 *   - 방문자가 이 브라우저에 키를 넣었나 — `lib/apiKeys.ts`(localStorage)
 *
 * 대화·도구 판정·임베딩·OCR/비전이 모두 Gemini 키 하나로 돈다 — 그래서
 * `chatReady`와 `visionReady`는 늘 같은 값이다(필드를 둘 다 둔 건 호출부가
 * "무엇이 잠겼나"로 읽게 하려는 것). 서버에 키가 있으면 입력 UI는 **아예 뜨지
 * 않는다**(`needsGeminiInput=false`). 둘 다 없으면 AI만 잠그고 안내한다 —
 * 앱 전체를 막지 않는다.
 *
 * 업로드는 다르다: 문서 파싱(Upstage)이 워커에서 돌아 헤더 키가 닿지 않는다.
 * `uploadEnabled`는 서버가 알려 주는 값만 따르고, 방문자 키로는 못 연다.
 */

import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { loadApiKeys, subscribeApiKeys } from "@/lib/apiKeys";

export type PublicConfig = {
  upstage_key_configured: boolean;
  gemini_key_configured: boolean;
  upload_enabled: boolean;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api";

async function fetchPublicConfig(): Promise<PublicConfig> {
  const res = await fetch(`${API_BASE}/config`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// useSyncExternalStore는 같은 값이면 같은 참조를 원한다 — 문자열로 비교한다.
function keysSnapshot(): string {
  const k = loadApiKeys();
  return k.gemini ? "1" : "0";
}

export type AiReadiness = {
  /** 설정 조회가 끝났나. 끝나기 전에는 아무것도 잠그지 않는다(깜빡임 방지). */
  loaded: boolean;
  /** 대화 생성·도구 판정·임베딩(Gemini)을 쓸 수 있다. */
  chatReady: boolean;
  /** 비전(손글씨·펜 표시 해석 — Gemini)을 쓸 수 있다. chatReady와 같은 키다. */
  visionReady: boolean;
  /** 파일 업로드(서버 .env의 Upstage 키 전용 — 워커가 헤더를 못 본다). */
  uploadEnabled: boolean;
  /** 항상 false — Upstage 키는 화면에서 받지 않는다(옛 호출부 호환용으로 남김). */
  needsUpstageInput: boolean;
  /** 입력 UI에 Gemini 칸을 보여야 하나(서버 .env에 키가 없다). */
  needsGeminiInput: boolean;
};

/**
 * 설정 응답 + 브라우저 키 보유 여부 → 준비 상태. 훅에서 떼어 낸 순수 함수 —
 * 서버 키/브라우저 키/업로드의 조합표를 렌더 없이 테스트하려고.
 * `config`가 null이면 아직 조회 전이다(아무것도 잠그지 않는다).
 */
export function deriveAiReadiness(
  config: PublicConfig | null,
  hasBrowserGeminiKey: boolean,
): AiReadiness {
  if (!config) {
    return {
      loaded: false,
      chatReady: true,
      visionReady: true,
      uploadEnabled: true,
      needsUpstageInput: false,
      needsGeminiInput: false,
    };
  }
  const geminiReady = config.gemini_key_configured || hasBrowserGeminiKey;
  return {
    loaded: true,
    chatReady: geminiReady,
    visionReady: geminiReady,
    uploadEnabled: config.upload_enabled,
    needsUpstageInput: false,
    needsGeminiInput: !config.gemini_key_configured,
  };
}

export function useAiReadiness(): AiReadiness {
  const { data, isSuccess } = useQuery({
    queryKey: ["public-config"],
    queryFn: fetchPublicConfig,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const snap = useSyncExternalStore(subscribeApiKeys, keysSnapshot, () => "0");
  return deriveAiReadiness(isSuccess && data ? data : null, snap === "1");
}
