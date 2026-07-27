import { ApiError } from "@/lib/api";

/**
 * react-query 재시도 정책 (D105).
 *
 * QueryClient 설정 안에 인라인으로 두면 테스트할 수 없어서 분리했다 —
 * 정책은 되돌아가기 쉬운 종류의 결정이라 계약을 테스트로 고정해 둔다.
 */

/** 재시도해도 결과가 바뀌지 않는 상태 코드인가. */
export function isTerminalStatus(status: number): boolean {
  // 4xx는 "요청이 잘못됐다"는 서버의 확정 답이다 — 같은 요청을 세 번 더 보내도
  // 같은 답이 온다. 예외는 둘: 408(타임아웃)과 429(레이트리밋)는 시간이 지나면
  // 성공할 수 있다.
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * 기본값(retry: 3)은 4xx에도 걸려서, 프로필이 없는 사용자의 `/auth/me` 404가
 * 요청 4번으로 불어났다(실측 2026-07-27: 로그에 404 12건). 서버가 "없다"고
 * 확정한 것을 세 번 더 물어보는 낭비이고, 오류 표시도 그만큼 늦어진다.
 * 5xx·네트워크 장애는 일시적일 수 있으므로 기존대로 재시도한다.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && isTerminalStatus(error.status)) return false;
  return failureCount < 3;
}
