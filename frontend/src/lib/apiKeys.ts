/**
 * 방문자가 화면에서 넣은 외부 API 키 (공개판 C 분류, 2026-09-27).
 *
 * ## 규칙
 * - 서버 `.env`에 키가 있으면 이 저장소는 **쓰이지 않는다** — 입력 UI 자체가
 *   안 뜬다(`GET /api/config`가 true를 준다). 서버도 헤더를 무시한다.
 * - 키는 **이 브라우저의 localStorage에만** 있다. 서버는 요청마다 헤더로 받아
 *   그 요청 동안만 쓰고 저장하지 않는다(backend/app/services/api_keys.py).
 * - 비전 모델은 허용 목록 안에서만 고른다. 서버도 같은 목록으로 다시 거른다.
 *
 * 헤더 이름은 서버 api_keys.py와 같아야 한다.
 */

export type ApiKeys = {
  upstage: string;
  gemini: string;
  geminiModel: string;
};

/** 백엔드 api_keys.GEMINI_VISION_MODELS와 같은 목록. Pro 계열은 넣지 않는다. */
export const GEMINI_VISION_MODELS = [
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (기본 · 가장 저렴)" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
] as const;

export const DEFAULT_GEMINI_MODEL = GEMINI_VISION_MODELS[0].id;

export const KEY_LINKS = {
  upstage: "https://console.upstage.ai/api-keys",
  gemini: "https://aistudio.google.com/apikey",
} as const;

const STORAGE_KEY = "nodi.apiKeys.v1";
const EMPTY: ApiKeys = { upstage: "", gemini: "", geminiModel: DEFAULT_GEMINI_MODEL };

/** 바뀌면 알린다 — 입력 UI를 닫은 순간 채팅 입력창의 "키 필요" 안내가 풀려야 한다. */
const listeners = new Set<() => void>();

export function loadApiKeys(): ApiKeys {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<ApiKeys>;
    const model = GEMINI_VISION_MODELS.some((m) => m.id === parsed.geminiModel)
      ? (parsed.geminiModel as string)
      : DEFAULT_GEMINI_MODEL;
    return {
      upstage: typeof parsed.upstage === "string" ? parsed.upstage : "",
      gemini: typeof parsed.gemini === "string" ? parsed.gemini : "",
      geminiModel: model,
    };
  } catch {
    // 사생활 보호 모드 등 저장소를 못 쓰는 브라우저 — 키 없음으로 친다.
    return EMPTY;
  }
}

export function saveApiKeys(next: ApiKeys): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        upstage: next.upstage.trim(),
        gemini: next.gemini.trim(),
        geminiModel: next.geminiModel,
      }),
    );
  } catch {
    /* 저장 불가 — 이번 탭에서도 못 쓴다. 입력 UI가 다시 뜬다. */
  }
  listeners.forEach((fn) => fn());
}

export function subscribeApiKeys(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 요청에 실을 헤더. 비어 있는 키는 싣지 않는다. */
export function apiKeyHeaders(): Record<string, string> {
  const keys = loadApiKeys();
  const headers: Record<string, string> = {};
  if (keys.upstage) headers["X-Upstage-Key"] = keys.upstage;
  if (keys.gemini) {
    headers["X-Gemini-Key"] = keys.gemini;
    headers["X-Gemini-Model"] = keys.geminiModel;
  }
  return headers;
}
