// 08 D63: 임시(낙관) id가 DB 경계로 새지 않게 하는 단일 방어선.
// 낙관 UI가 늘어날수록 클라 전용 id(optimistic:/provisional:/pending:)가 영속·PATCH·
// DELETE 경로로 흘러 PostgREST uuid 400 → 502가 재발할 위험이 커진다
// (memory recurring-bug-patterns 패턴 2, 06 D52). 모든 id-전송 api 함수가 이 유틸로
// 입구에서 비-UUID를 걸러낸다.

/** 표준 UUID(8-4-4-4-12). */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 실제 DB id(UUID)인가. 낙관 항목의 임시 id는 false. */
export function isRealId(id: string | null | undefined): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

/** 낙관(미확정) 클라 전용 id인가. optimistic:/provisional:/pending: 등 모두 포함. */
export function isOptimistic(id: string | null | undefined): boolean {
  return !isRealId(id);
}

/** 낙관 항목 임시 id 생성(접두 표준화). DB로는 절대 보내지 않는다. */
export function makeOptimisticId(prefix = "optimistic"): string {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}:${rand}`;
}

/**
 * DB 경계 가드: id가 실제 UUID가 아니면 네트워크 호출 전에 즉시 던진다.
 * 낙관 표준 훅이 임시 id를 mutationFn에 넘기지 못하게 막지만, api 함수 자체도
 * 단일 방어선으로 같은 규칙을 강제해 502 재발을 차단한다(이중 방어).
 */
export function assertRealId(id: string, label = "id"): void {
  if (!isRealId(id)) {
    throw new Error(`비-UUID ${label}는 서버로 보낼 수 없습니다: ${id}`);
  }
}
