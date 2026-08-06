/**
 * 질문 방향성 코치 (D194).
 *
 * **언제 말을 걸지는 화면이 정하고**(`lib/canvas2/questionCoach.ts`), 무슨 말을
 * 할지는 서버가 정한다. 판정 로직을 양쪽에 두면 반드시 갈리고, 그 어긋남은
 * "가끔 안 뜬다"로만 보인다.
 */
import { API_BASE, authHeaders, ensureOk, registerCacheClear } from "./_core";

export interface CoachSettings {
  enabled: boolean;
  /** n — 이만큼 쌓인 뒤 하나 더 이어지면 말을 건다. */
  min_cards: number;
}

export interface CoachAdvice {
  topic: string;
  /** 지금까지 물어 온 방향 (1개 이상). */
  covered: string[];
  /** 아직 안 물은 방향 (1개 이상). */
  suggest: string[];
  /** 말풍선 두 줄. */
  bubble: string;
  /** 입력창 위 한 줄 — 방향만 풀어 쓴 것이지 베낄 질문이 아니다. */
  hint: string;
}

/**
 * 노브를 다시 물어보기까지의 시간(ms).
 *
 * 서버의 오버레이 TTL(20초)보다 넉넉히 잡되 한 수업(45분)보다는 짧게 둔다 —
 * 관리자가 콘솔에서 n을 바꾸면 **다음 학생 턴 몇 번 안에** 반영돼야 하고,
 * 그렇다고 턴마다 물어볼 값도 아니다.
 */
const SETTINGS_TTL_MS = 60_000;

let cached: { at: number; value: CoachSettings } | null = null;

/**
 * 코치 노브. **턴마다 서버에 묻지 않는다.**
 *
 * 코치는 답이 끝날 때마다 도는데, 그 대부분은 "아직 얕다"로 곧장 끝난다
 * (기본 n=3이면 네 번째 카드에서야 말을 건다). 그런데도 매번 왕복이 하나
 * 나가고 있었다 — 학생 한 명이 스무 턴을 하면 스무 번이다. 값은 거의 안
 * 바뀌므로 짧게 기억한다.
 */
export async function getCoachSettings(): Promise<CoachSettings> {
  const now = Date.now();
  if (cached && now - cached.at < SETTINGS_TTL_MS) return cached.value;
  const res = await ensureOk(
    await fetch(`${API_BASE}/coach/settings`, { headers: await authHeaders() }),
  );
  const value = (await res.json()) as CoachSettings;
  cached = { at: now, value };
  return value;
}

/** 테스트·로그아웃용 — 기억한 노브를 버린다. */
export function clearCoachSettingsCache(): void {
  cached = null;
}

registerCacheClear(clearCoachSettingsCache);

/**
 * 이 브랜치에 안 물어본 방향을 묻는다. **말할 것이 없으면 `null`**이다 —
 * 오류가 아니라 정상 응답이다(억지로 채우면 소음이 된다).
 */
export async function askQuestionDirections(
  itemIds: string[],
): Promise<CoachAdvice | null> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/coach/question-directions`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ item_ids: itemIds }),
    }),
  );
  const body = (await res.json()) as { coach: CoachAdvice | null };
  return body.coach;
}
