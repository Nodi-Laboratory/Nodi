"use client";

import { useParams } from "next/navigation";
import { ConceptCanvasWorkspace } from "@/components/canvas/ConceptCanvasWorkspace";

/**
 * 공간 워크스페이스 — 개념카드 노트 캔버스.
 * 질문하면 EXAONE가 개념 카드를 무한 캔버스에 뿌리고, 유사도 개념 트리로 탐색한다.
 * spaceId='personal' → 개인 공간, spaceId=<class uuid> → 학급 공간.
 */
export default function SpaceWorkspacePage() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = String(params.spaceId);

  return <ConceptCanvasWorkspace key={spaceId} spaceId={spaceId} />;
}
