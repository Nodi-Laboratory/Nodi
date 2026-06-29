"use client";

import { useCallback } from "react";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";

/**
 * 08 D61/D62 — 낙관 UI 표준 라이프사이클(리스트 캐시판).
 *
 * nodi엔 손으로 짠 낙관 패턴이 여러 곳(자료 RAG 링크, 자료 배치 등)에 제각각 있었다.
 * 공통 라이프사이클은 항상 같다:
 *   [클릭] → (즉시) 낙관 항목 삽입(pending 시각) → 서버 확정 → 실체화 / 실패 → 롤백
 * 이 훅은 "리스트 캐시에 낙관 항목 삽입/제거 + 스냅샷 복원"을 한 곳으로 모아
 * 모든 지연 작업이 같은 규칙(임시 id 가드 결합·중복 가드)을 쓰게 한다.
 *
 * 캐시 모양이 단순 배열(T[])인 쿼리에 쓴다. SessionDetail.nodes처럼 중첩된 캐시
 * (대화 노드 SSE 특수 케이스, §1.5)는 자체 reconcile을 유지한다.
 *
 * react-compiler 주의: 낙관 상태를 effect의 setState가 아니라 react-query 캐시
 * (setQueryData)로만 관리해 `react-hooks/set-state-in-effect`를 피한다.
 */
export interface OptimisticList<T> {
  /** 현재 리스트 스냅샷(롤백 복원용). */
  snapshot: () => T[] | undefined;
  /** 스냅샷으로 되돌린다(롤백). */
  restore: (snap: T[] | undefined) => void;
  /**
   * 낙관 항목을 삽입한다. dup(중복 가드)이 true를 반환하면 삽입을 건너뛰고 false 반환.
   * 삽입했으면 true(=실패 시 이 항목만 롤백 대상).
   */
  insert: (
    item: T,
    opts?: { front?: boolean; dup?: (existing: T[]) => boolean },
  ) => boolean;
  /** 조건에 맞는 항목을 제거한다(낙관 롤백·실체화 정리). */
  removeWhere: (pred: (item: T) => boolean) => void;
  /** 캐시 리스트를 직접 변환한다(부분 갱신). */
  update: (fn: (prev: T[]) => T[]) => void;
}

export function useOptimisticList<T>(queryKey: QueryKey): OptimisticList<T> {
  const qc = useQueryClient();

  const snapshot = useCallback(
    () => qc.getQueryData<T[]>(queryKey),
    [qc, queryKey],
  );

  const restore = useCallback(
    (snap: T[] | undefined) => qc.setQueryData<T[]>(queryKey, snap),
    [qc, queryKey],
  );

  const insert = useCallback(
    (
      item: T,
      opts?: { front?: boolean; dup?: (existing: T[]) => boolean },
    ): boolean => {
      const current = qc.getQueryData<T[]>(queryKey) ?? [];
      if (opts?.dup?.(current)) return false;
      qc.setQueryData<T[]>(
        queryKey,
        opts?.front ? [item, ...current] : [...current, item],
      );
      return true;
    },
    [qc, queryKey],
  );

  const removeWhere = useCallback(
    (pred: (item: T) => boolean) => {
      qc.setQueryData<T[]>(queryKey, (old) =>
        (old ?? []).filter((x) => !pred(x)),
      );
    },
    [qc, queryKey],
  );

  const update = useCallback(
    (fn: (prev: T[]) => T[]) => {
      qc.setQueryData<T[]>(queryKey, (old) => fn(old ?? []));
    },
    [qc, queryKey],
  );

  return { snapshot, restore, insert, removeWhere, update };
}
