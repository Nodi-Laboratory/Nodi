"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type { SpaceKind } from "@/lib/types";

/** space_kind/space_ref → 라우트 spaceId */
function toSpaceId(kind: SpaceKind, ref?: string | null): string {
  return kind === "personal" ? "personal" : (ref ?? "personal");
}

/**
 * 홈에서 워크스페이스로 진입하는 동작.
 *
 * 예전에는 홈에서 질문을 적어 새 세션을 시작하는 `startSeeded`도 있었는데,
 * 홈에 질문 입력이 없어지면서 호출자가 0이 됐다. 죽은 코드를 남겨 두면
 * 다음 사람이 그 경로가 살아 있다고 오해한다 — 되살릴 때 다시 쓰면 된다.
 * 둘 다 store.pendingSession에 기록 후 /space/{spaceId}로 이동 → useSessionBinding이 소비.
 */
export function useStartSession() {
  const router = useRouter();
  const setPendingSession = useWorkspaceStore((s) => s.setPendingSession);

  const openSession = useCallback(
    (spaceKind: SpaceKind, spaceRef: string | null, sessionId: string) => {
      const spaceId = toSpaceId(spaceKind, spaceRef);
      setPendingSession({ spaceId, sessionId });
      router.push(`/space/${spaceId}`);
    },
    [router, setPendingSession],
  );

  return { openSession };
}
