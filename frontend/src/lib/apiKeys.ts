/**
 * 방문자가 화면에서 넣은 외부 API 키 (공개판 C 분류, 2026-09-27).
 *
 * ## 키는 Gemini 하나다 (2026-11-17 "모두 gemini로")
 * 대화·도구 판정·임베딩·OCR/비전이 전부 Gemini 키 하나로 돈다. 방문자가 넣을
 * 것은 그것뿐이다. Upstage 키는 문서 파싱(파일 **업로드**)에만 남았는데, 그건
 * 백그라운드 워커가 처리해 헤더 키가 닿지 않으므로 서버 `.env`로만 준다 —
 * 그래서 입력 UI에는 없다.
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
  /**
   * 옛 저장 JSON(v1)에 있던 칸. 화면에는 더 이상 보이지 않지만, 이미 저장된
   * 값이 읽기에서 깨지지 않게 형태는 유지하고 헤더에도 그대로 싣는다
   * (백엔드가 X-Upstage-Key를 아직 받는다 — 해롭지 않다).
   */
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
  gemini: "https://aistudio.google.com/apikey",
} as const;

const STORAGE_KEY = "nodi.apiKeys.v1";
const EMPTY: ApiKeys = { upstage: "", gemini: "", geminiModel: DEFAULT_GEMINI_MODEL };

/**
 * 저장된 JSON 한 덩어리 → ApiKeys. 깨진 필드는 빈 값·기본 모델로 떨군다.
 * (순수 함수로 뺀 이유: 옛 v1 JSON·알 수 없는 모델 같은 경계 케이스를 localStorage
 * 없이 테스트하려고.)
 */
export function parseStoredKeys(raw: string | null): ApiKeys {
  if (!raw) return EMPTY;
  const parsed = JSON.parse(raw) as Partial<ApiKeys> | null;
  if (!parsed || typeof parsed !== "object") return EMPTY;
  const model = GEMINI_VISION_MODELS.some((m) => m.id === parsed.geminiModel)
    ? (parsed.geminiModel as string)
    : DEFAULT_GEMINI_MODEL;
  return {
    upstage: typeof parsed.upstage === "string" ? parsed.upstage : "",
    gemini: typeof parsed.gemini === "string" ? parsed.gemini : "",
    geminiModel: model,
  };
}

/** 바뀌면 알린다 — 입력 UI를 닫은 순간 채팅 입력창의 "키 필요" 안내가 풀려야 한다. */
const listeners = new Set<() => void>();

export function loadApiKeys(): ApiKeys {
  if (typeof window === "undefined") return EMPTY;
  try {
    return parseStoredKeys(window.localStorage.getItem(STORAGE_KEY));
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
