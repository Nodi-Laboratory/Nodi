"use client";

import { useParams } from "next/navigation";
import { WorkspaceInner } from "@/components/workspace/WorkspaceInner";

/**
 * 공간 워크스페이스 — 3분할 (Stage 1).
 * [대화기록 사이드바 | 대화 패널(SSE) | 세션 그래프 뷰(D3)]
 * spaceId='personal' → 개인 공간, spaceId=<class uuid> → 학급 공간.
 */
export default function SpaceWorkspacePage() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = String(params.spaceId);

  return <WorkspaceInner key={spaceId} spaceId={spaceId} />;
}
