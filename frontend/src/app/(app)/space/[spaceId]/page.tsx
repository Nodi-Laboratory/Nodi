"use client";

import { useParams } from "next/navigation";
import { CanvasWorkspace } from "@/components/canvas2/CanvasWorkspace";

/**
 * 학습 캔버스 (D120~D127).
 *
 * `key={spaceId}`가 유일한 리마운트 경계다 — 공간을 바꾸면 카메라·태그 순서·
 * 그림 씬이 전부 초기화된다. 세션 전환은 리마운트가 아니므로 훅 안에서
 * 세션 키로 다룬다(useItemLayout 참조).
 */
export default function SpacePage() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = params?.spaceId ?? "personal";
  return <CanvasWorkspace key={spaceId} spaceId={spaceId} />;
}
