"use client";

/**
 * AI 기능이 지금 쓸 수 있는가 (공개판 C 분류, 2026-09-27).
 *
 * 두 출처를 합친다:
 *   - 서버 `.env`에 키가 있나 — `GET /api/config`(true/false만 온다)
 *   - 방문자가 이 브라우저에 키를 넣었나 — `lib/apiKeys.ts`(localStorage)
 *
 * 서버에 키가 있으면 입력 UI는 **아예 뜨지 않는다**(`needs*Input=false`).
 * 둘 다 없으면 그 기능만 잠그고 안내한다 — 앱 전체를 막지 않는다.
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
  return `${k.upstage ? 1 : 0}${k.gemini ? 1 : 0}`;
}

export type AiReadiness = {
  /** 설정 조회가 끝났나. 끝나기 전에는 아무것도 잠그지 않는다(깜빡임 방지). */
  loaded: boolean;
  /** 대화 생성(Upstage)을 쓸 수 있다. */
  chatReady: boolean;
  /** 비전(손글씨·펜 표시 해석 — Gemini)을 쓸 수 있다. */
  visionReady: boolean;
  /** 파일 업로드(.env Upstage 키 전용 — 워커가 헤더를 못 본다). */
  uploadEnabled: boolean;
  /** 입력 UI에 Upstage 칸을 보여야 하나(서버 .env에 키가 없다). */
  needsUpstageInput: boolean;
  needsGeminiInput: boolean;
};

export function useAiReadiness(): AiReadiness {
  const { data, isSuccess } = useQuery({
    queryKey: ["public-config"],
    queryFn: fetchPublicConfig,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const snap = useSyncExternalStore(subscribeApiKeys, keysSnapshot, () => "00");
  const hasUpstage = snap[0] === "1";
  const hasGemini = snap[1] === "1";

  if (!isSuccess || !data) {
    return {
      loaded: false,
      chatReady: true,
      visionReady: true,
      uploadEnabled: true,
      needsUpstageInput: false,
      needsGeminiInput: false,
    };
  }
  return {
    loaded: true,
    chatReady: data.upstage_key_configured || hasUpstage,
    visionReady: data.gemini_key_configured || hasGemini,
    uploadEnabled: data.upload_enabled,
    needsUpstageInput: !data.upstage_key_configured,
    needsGeminiInput: !data.gemini_key_configured,
  };
}
