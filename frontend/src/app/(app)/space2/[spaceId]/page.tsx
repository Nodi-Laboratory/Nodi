"use client";

/**
 * 캔버스 v2 개발용 라우트. **P6에서 /space/[spaceId]로 옮기고 이 파일은 지운다.**
 *
 * 기존 /space를 건드리지 않고 나란히 띄워 비교하기 위한 자리다.
 */

import { useParams } from "next/navigation";
import { CanvasWorkspace } from "@/components/canvas2/CanvasWorkspace";

export default function Space2Page() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = params?.spaceId ?? "personal";
  return <CanvasWorkspace key={spaceId} spaceId={spaceId} />;
}
