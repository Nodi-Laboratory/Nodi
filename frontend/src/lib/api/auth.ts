/** 가입·로그인 — 자체 인증 백엔드 호출 (D104-7). */
import { API_BASE, ApiError, ensureOk } from "./_core";

export interface AuthResult {
  access_token: string;
  token_type: string;
  user_id: string;
  email: string | null;
  /**
   * 토큰이 몇 초 뒤에 죽나 — **쿠키 수명은 이 값을 따른다** (2026-08-10).
   *
   * 예전에는 화면이 12시간을 따로 적어 뒀다. 같은 사실이 두 곳에 있으면
   * 반드시 갈린다(D219) — 서버 `JWT_EXPIRE_MINUTES`를 줄이면 쿠키만 살아남는다.
   * 옛 서버와도 맞물리게 optional로 둔다.
   */
  expires_in?: number;
}

/** 인증 요청은 토큰이 없는 상태에서 나가므로 authHeaders를 쓰지 않는다. */
async function postJson(path: string, body: unknown): Promise<AuthResult> {
  const res = await ensureOk(
    await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return res.json();
}

export async function signup(input: {
  email: string;
  password: string;
  display_name?: string | null;
  /** 서버가 화이트리스트(student|teacher)를 강제한다 — admin은 여기서 못 얻는다. */
  role: "student" | "teacher";
}): Promise<AuthResult> {
  return postJson("/auth/signup", input);
}

export async function login(
  email: string,
  password: string,
): Promise<AuthResult> {
  return postJson("/auth/login", { email, password });
}

/**
 * 백엔드 오류 메시지를 화면 문구로.
 *
 * 로그인 실패는 서버가 이미 "이메일 또는 비밀번호가 올바르지 않습니다"로 통일해
 * 계정 존재 여부를 감춘다 — 프론트에서 다시 갈라 쓰지 않는다.
 */
export function authErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    // FastAPI 검증 오류(422)는 detail이 배열이라 그대로 보여줄 수 없다.
    if (err.status === 422) return "입력값을 확인해 주세요.";
    if (err.message && !err.message.startsWith("HTTP ")) return err.message;
  }
  return fallback;
}
