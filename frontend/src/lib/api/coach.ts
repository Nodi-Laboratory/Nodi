/**
 * 질문 방향성 코치 (D194).
 *
 * **언제 말을 걸지는 화면이 정하고**(`lib/canvas2/questionCoach.ts`), 무슨 말을
 * 할지는 서버가 정한다. 판정 로직을 양쪽에 두면 반드시 갈리고, 그 어긋남은
 * "가끔 안 뜬다"로만 보인다.
 */
import { API_BASE, authHeaders, ensureOk } from "./_core";

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

export async function getCoachSettings(): Promise<CoachSettings> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/coach/settings`, { headers: await authHeaders() }),
  );
  return (await res.json()) as CoachSettings;
}

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
