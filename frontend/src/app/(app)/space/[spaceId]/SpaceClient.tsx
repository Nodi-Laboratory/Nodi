"use client";

import { CanvasWorkspace } from "@/components/canvas2/CanvasWorkspace";
import { SpaceGuard } from "@/components/canvas2/SpaceGuard";

/**
 * 학습 캔버스 (D120~D127).
 *
 * `key={spaceId}`가 유일한 리마운트 경계다 — 공간을 바꾸면 카메라·태그 순서·
 * 그림 씬이 전부 초기화된다. 세션 전환은 리마운트가 아니므로 훅 안에서
 * 세션 키로 다룬다(useItemLayout 참조).
 *
 * 공간 id는 **프롭으로 받는다**(D209). `useParams`로 읽으면 이 파일이
 * 라우트에 묶여 재사용도 시험도 어려워지는데, 서버 껍데기가 이미 갖고 있는
 * 값을 굳이 훅으로 다시 읽을 이유가 없다.
 */
export function SpaceClient({
  spaceId,
  openMap = false,
}: {
  spaceId: string;
  /** 지도를 연 채로 시작한다 (`?map=1`). */
  openMap?: boolean;
}) {
  return (
    // 내 방이 아니면 빈 캔버스 대신 **무슨 일인지** 보여 준다 (D201).
    <SpaceGuard spaceId={spaceId}>
      <CanvasWorkspace key={spaceId} spaceId={spaceId} mapOnLoad={openMap} />
    </SpaceGuard>
  );
}
