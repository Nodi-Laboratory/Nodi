"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { createSession } from "@/lib/api";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type { SpaceKind } from "@/lib/types";

/** space_kind/space_ref → 라우트 spaceId */
function toSpaceId(kind: SpaceKind, ref?: string | null): string {
  return kind === "personal" ? "personal" : (ref ?? "personal");
}

/**
 * 홈에서 워크스페이스로 진입하는 동작.
 * - startSeeded: 새 세션을 만들고 시드 질문을 첫 질문으로 시작.
 * - openSession: 기존 세션을 열기(선택).
 * 둘 다 store.pendingSession에 기록 후 /space/{spaceId}로 이동 → useSessionBinding이 소비.
 */
export function useStartSession() {
  const router = useRouter();
  const setPendingSession = useWorkspaceStore((s) => s.setPendingSession);

  const startSeeded = useCallback(
    async (opts: {
      spaceKind: SpaceKind;
      spaceRef?: string | null;
      seed: string;
    }) => {
      const spaceId = toSpaceId(opts.spaceKind, opts.spaceRef);
      const session = await createSession({
        space_kind: opts.spaceKind,
        space_ref: opts.spaceRef ?? undefined,
      });
      setPendingSession({ spaceId, sessionId: session.id, seed: opts.seed });
      router.push(`/space/${spaceId}`);
    },
    [router, setPendingSession],
  );

  const openSession = useCallback(
    (spaceKind: SpaceKind, spaceRef: string | null, sessionId: string) => {
      const spaceId = toSpaceId(spaceKind, spaceRef);
      setPendingSession({ spaceId, sessionId });
      router.push(`/space/${spaceId}`);
    },
    [router, setPendingSession],
  );

  return { startSeeded, openSession };
}
