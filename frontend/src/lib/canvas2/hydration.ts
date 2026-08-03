/**
 * 캔버스를 **언제** 서버 스냅샷으로 채울 것인가 (D147).
 *
 * ## 무엇이 고장났었나
 *
 * 수화(hydration) 이펙트가 `snapshot`과 `detail`(세션 노드) **둘 다**를
 * 의존성으로 갖고, 올 때마다 `replaceAll`로 화면을 통째로 갈아치웠다.
 * 그런데 이 둘은 서로 다른 쿼리이고 갱신 시점도 다르다:
 *
 *     ["canvas", sid]   staleTime Infinity  — 세션을 처음 열 때 한 번
 *     ["session", sid]  staleTime 30s       — 채팅 뒤·재진입 때 다시 받는다
 *
 * 빈 세션을 열면 캔버스 스냅샷은 `items: []`로 **캐시에 박힌다.** 학생이
 * 질문해 AI 글이 생기고 서버에도 저장되지만 그 캐시는 갱신되지 않는다.
 * 잠시 뒤 `detail`이 갱신되는 순간(세션을 바꿨다 돌아오면 확실히 그렇다)
 * 이펙트가 다시 돌고, `snapshot.items`가 비어 있으니 **구 세션 폴백**으로
 * 떨어져 `nodes.answer`를 파싱한 `_legacy` 복사본으로 화면을 덮는다.
 *
 * 결과가 둘이다.
 *
 *   1. 학생이 옮겨 둔 좌표가 사라진다 — `_legacy`는 x/y가 0이라 배치 엔진이
 *      열 자리로 도로 끌어간다("원래 위치로 돌아왔다").
 *   2. **행이 복제된다** — `_legacy` 글을 옮기면 "첫 편집이 곧 승격"
 *      경로가 `POST /canvas/items`로 **새 행**을 만든다. 이동 한 번에
 *      3행, 두 번이면 6행. 새로고침하면 원본 3 + 복제 6 = 9개가 뜬다
 *      (사용자 실측 2026-08-02).
 *
 * ## 규칙
 *
 * **수화는 세션당 한 번이다.** 그 뒤로 화면의 글이 정본이고(모든 편집은
 * 즉시 서버로 나간다), 뒤늦게 도착한 쿼리가 그것을 덮을 수 없다.
 *
 * 판정만 순수 함수로 떼어 둔다 — 이 결함은 눈으로 못 잡는다(화면에는 글이
 * 그대로 있고, 잘못된 것은 그 글의 **정체**다). 테스트로 잡는다.
 */

export interface HydrationState {
  /** 지금 열려 있는 세션. 아직 못 정했으면 null. */
  sessionId: string | null;
  /** 이미 채워 넣은 세션 id. 화면의 글이 이 세션 것이라는 뜻이다. */
  hydratedFor: string | null;
  /** 서버 스냅샷의 글 수. **스냅샷이 아직 안 왔으면 null**(0과 구별한다). */
  snapshotCount: number | null;
  /**
   * 세션 상세(nodes)를 아직 기다리는 중인가.
   *
   * 스냅샷이 비었을 때 "v2 이전 세션이라 파싱해야 한다"와 "정말 빈
   * 세션이다"는 nodes를 봐야 갈린다. 기다리지 않고 빈 것으로 단정하면
   * 구 세션이 빈 캔버스로 뜬다.
   */
  detailPending: boolean;
}

export interface HydrationPlan {
  /** 화면의 글을 먼저 비운다 — 세션이 바뀌었는데 이전 글이 남아 있다. */
  clear: boolean;
  /** 무엇으로 채우나. null이면 **이번에는 채우지 않는다**(기다린다). */
  fill: "items" | "nodes" | null;
}

const NOTHING: HydrationPlan = { clear: false, fill: null };

export function planHydration(s: HydrationState): HydrationPlan {
  // 세션이 사라졌다(로그아웃·삭제) — 남은 글은 남의 것이 된다.
  if (!s.sessionId) {
    return s.hydratedFor ? { clear: true, fill: null } : NOTHING;
  }
  // 이미 이 세션을 채웠다. **화면이 정본이다** — 늦게 온 쿼리는 무시한다.
  if (s.hydratedFor === s.sessionId) return NOTHING;

  const clear = s.hydratedFor !== null;

  // 스냅샷을 기다리는 중. 이전 세션 글은 지금 비운다 — 새 세션의 화면에
  // 남의 글이 잠시라도 떠 있으면 학생이 그걸 옮기거나 지울 수 있다.
  if (s.snapshotCount === null) return { clear, fill: null };
  if (s.snapshotCount > 0) return { clear, fill: "items" };
  if (s.detailPending) return { clear, fill: null };
  return { clear, fill: "nodes" };
}
