/**
 * 방문자 API 키 저장소 (Gemini 단일 키, 2026-11-17).
 *
 * 지키는 것: ① 옛 v1 JSON(`upstage` 칸 포함)이 에러 없이 읽힌다 — 이미 키를 넣어 둔
 * 방문자가 업데이트 후 깨지면 안 된다. ② 헤더는 있는 키만, Gemini 모델은 키와
 * 함께 실린다. ③ 목록에 없는 모델은 기본값으로 떨어진다(서버도 같은 목록으로 거른다).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyHeaders,
  DEFAULT_GEMINI_MODEL,
  GEMINI_VISION_MODELS,
  loadApiKeys,
  parseStoredKeys,
  saveApiKeys,
} from "./apiKeys";

const STORAGE_KEY = "nodi.apiKeys.v1";

/** node 환경에는 window가 없다 — 메모리 localStorage로 대신한다. */
function stubStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(STORAGE_KEY, initial);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("parseStoredKeys", () => {
  it("저장값이 없으면 빈 키 + 기본 모델", () => {
    expect(parseStoredKeys(null)).toEqual({
      upstage: "",
      gemini: "",
      geminiModel: DEFAULT_GEMINI_MODEL,
    });
  });

  it("옛 JSON(upstage 포함)도 에러 없이 읽는다", () => {
    const keys = parseStoredKeys(
      JSON.stringify({ upstage: "up_old", gemini: "g-key", geminiModel: "gemini-3.5-flash" }),
    );
    expect(keys).toEqual({ upstage: "up_old", gemini: "g-key", geminiModel: "gemini-3.5-flash" });
  });

  it("upstage 칸이 없는 새 JSON도 읽는다", () => {
    expect(parseStoredKeys(JSON.stringify({ gemini: "g" })).upstage).toBe("");
  });

  it("목록에 없는 모델은 기본 모델로 떨어진다", () => {
    const keys = parseStoredKeys(JSON.stringify({ gemini: "g", geminiModel: "gemini-9-pro" }));
    expect(keys.geminiModel).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("타입이 틀린 필드는 빈 값으로 친다", () => {
    const keys = parseStoredKeys(JSON.stringify({ upstage: 1, gemini: null, geminiModel: 3 }));
    expect(keys).toEqual({ upstage: "", gemini: "", geminiModel: DEFAULT_GEMINI_MODEL });
  });

  it("JSON이 null이어도 터지지 않는다", () => {
    expect(parseStoredKeys("null").gemini).toBe("");
  });

  it("허용 모델 목록과 기본값이 그대로다", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.5-flash-lite");
    expect(GEMINI_VISION_MODELS.map((m) => m.id)).toEqual([
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash",
      "gemini-3.6-flash",
    ]);
  });
});

describe("loadApiKeys", () => {
  it("window가 없으면(SSR) 빈 키", () => {
    expect(loadApiKeys().gemini).toBe("");
  });

  it("깨진 JSON이면 빈 키로 떨어진다", () => {
    stubStorage("{not json");
    expect(loadApiKeys().gemini).toBe("");
  });

  it("저장소 접근이 throw해도 빈 키", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect(loadApiKeys().gemini).toBe("");
  });
});

describe("apiKeyHeaders", () => {
  it("키가 없으면 아무 헤더도 싣지 않는다", () => {
    stubStorage();
    expect(apiKeyHeaders()).toEqual({});
  });

  it("Gemini 키가 있으면 키와 모델을 함께 싣는다", () => {
    stubStorage(JSON.stringify({ gemini: "g-key", geminiModel: "gemini-3.6-flash" }));
    expect(apiKeyHeaders()).toEqual({
      "X-Gemini-Key": "g-key",
      "X-Gemini-Model": "gemini-3.6-flash",
    });
  });

  it("Gemini 키가 없으면 모델 헤더도 싣지 않는다", () => {
    stubStorage(JSON.stringify({ gemini: "", geminiModel: "gemini-3.6-flash" }));
    expect(apiKeyHeaders()).toEqual({});
  });

  it("알 수 없는 모델은 기본 모델 헤더로 나간다", () => {
    stubStorage(JSON.stringify({ gemini: "g", geminiModel: "nope" }));
    expect(apiKeyHeaders()["X-Gemini-Model"]).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("옛 upstage 값은 있으면 계속 싣는다(백엔드가 아직 받는다)", () => {
    stubStorage(JSON.stringify({ upstage: "up_old", gemini: "g" }));
    expect(apiKeyHeaders()).toMatchObject({ "X-Upstage-Key": "up_old", "X-Gemini-Key": "g" });
  });
});

describe("saveApiKeys", () => {
  it("공백을 다듬어 저장하고 다시 읽으면 같다", () => {
    const store = stubStorage();
    saveApiKeys({ upstage: "", gemini: "  g-key \n", geminiModel: "gemini-3.5-flash" });
    expect(JSON.parse(store.get(STORAGE_KEY)!).gemini).toBe("g-key");
    expect(loadApiKeys().gemini).toBe("g-key");
  });
});
