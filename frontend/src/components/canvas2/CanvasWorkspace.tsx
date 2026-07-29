"use client";

/**
 * 캔버스 v2 오케스트레이터. `ConceptCanvasWorkspace`(397줄)를 대체한다.
 *
 * v1과의 책임 분담 차이:
 *
 *   v1  콘텐츠=useConceptStream · 좌표=useTagLayout(d3-force) · 카메라=이 컴포넌트
 *   v2  콘텐츠=useCanvasSession · 좌표=useItemLayout(결정론 배치) · 카메라=useCameraSpring
 *       뷰포트(팬/줌)=Excalidraw  ← 우리가 더 이상 소유하지 않는다
 *
 * P1 시점에서는 셸과 그리기까지만 붙어 있다. 아이템·스트림은 P2~P4에서 채운다.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DrawingScene } from "@/lib/api/canvas";
import { getCanvas, putDrawing } from "@/lib/api/canvas";
import { spaceTargetFromId } from "@/lib/api";
import { isRealId } from "@/lib/ids";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useExcalidrawBridge } from "@/lib/canvas2/useExcalidrawBridge";
import { useCameraSpring } from "@/lib/canvas2/useCameraSpring";
import { CanvasStage } from "./CanvasStage";

interface Props {
  spaceId: string;
}

export function CanvasWorkspace({ spaceId }: Props) {
  const bridge = useExcalidrawBridge();
  const spring = useCameraSpring(bridge);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => setActiveSpace(spaceId), [spaceId, setActiveSpace]);

  const sessionId = isRealId(activeSessionId) ? activeSessionId : null;

  // 캔버스 재수화 — 아이템 + 그림을 한 번에 받는다(두 번 왕복하면 그림 없는
  // 화면이 한 프레임 보였다가 튀어 들어온다).
  const { data: snapshot } = useQuery({
    queryKey: ["canvas", sessionId],
    queryFn: () => getCanvas(sessionId!),
    enabled: !!sessionId,
    staleTime: Infinity,
    // 캔버스는 사용자가 편집 중인 화면이다. 창을 다시 포커스했다고 서버
    // 스냅샷으로 덮으면 편집 중이던 위치가 되돌아간다.
    refetchOnWindowFocus: false,
  });

  // 그림은 Excalidraw가 소유하고 우리는 **마운트 시 한 번만** 밀어 넣는다
  // (`initialData`는 최초 1회만 읽힌다). 그래서 상태로 얼릴 필요가 없다 —
  // 리마운트 시점만 정해 주면 된다.
  //
  //   sceneKey는 **씬이 도착한 뒤에야** 값이 생긴다. sessionId로 키를 잡으면
  //   세션 전환 직후(쿼리 응답 전) null 씬으로 마운트돼 그림이 영영 안 뜬다.
  //   반대로 아이템 저장 후 invalidate로 스냅샷이 새로 와도 sceneKey는 그대로라
  //   Excalidraw가 리마운트되지 않는다 — 그리던 게 되감기지 않는다.
  const sceneKey = snapshot && sessionId ? sessionId : null;
  const initialScene = snapshot?.drawing ?? null;

  const commitScene = useCallback(
    (scene: DrawingScene) => {
      if (!sessionId) return;
      void putDrawing(sessionId, scene)
        .then(() => setSaveError(null))
        .catch((e: Error) => setSaveError(e.message));
    },
    [sessionId],
  );

  const target = useMemo(() => spaceTargetFromId(spaceId), [spaceId]);
  void target; // P4에서 세션 생성에 쓴다

  const handleCanvasClick = useCallback((world: { x: number; y: number }) => {
    // P3에서 note 아이템 생성으로 연결한다.
    console.debug("[canvas2] 글쓰기 도구 클릭", world);
  }, []);

  // 세션이 바뀌면 카메라를 원점으로. 이전 세션의 화면 위치를 물고 오면
  // 학생이 빈 공간을 보게 된다.
  useEffect(() => {
    spring.jumpTo({ scrollX: 80, scrollY: 80, zoom: 1 });
    // spring은 안정 참조가 아니므로 sessionId만 의존한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <CanvasStage
      bridge={bridge}
      key={sceneKey ?? "none"}
      initialScene={initialScene}
      onSceneCommit={commitScene}
      onCanvasClick={handleCanvasClick}
      chrome={saveError ? <SaveBanner message={saveError} /> : null}
    >
      {/* P2~P4: 아이템 · 연결선이 여기 들어온다 */}
      {!sessionId && <EmptyHint />}
    </CanvasStage>
  );
}

/**
 * 저장 실패를 조용히 넘기지 않는다.
 *
 * "RAG는 채팅을 절대 막지 않는다"와 같은 정신 — 저장이 실패해도 화면은
 * 계속 쓸 수 있어야 하지만, **실패했다는 사실은 반드시 보여야 한다.**
 * 학생이 30분 그린 걸 잃고 나서 아는 상황을 만들지 않는다.
 */
function SaveBanner({ message }: { message: string }) {
  return (
    <div
      data-no-pan
      className="ui absolute left-1/2 top-4 z-40 -translate-x-1/2 rounded-lg px-3 py-2 text-sm"
      style={{
        background: "var(--c-raised)",
        color: "var(--c-danger)",
        border: "1px solid var(--c-rule)",
        boxShadow: "var(--c-shadow-md)",
      }}
    >
      저장하지 못했습니다 — {message}
    </div>
  );
}

function EmptyHint() {
  return (
    <div
      className="ui pointer-events-none absolute select-none"
      style={{ left: 120, top: 140, color: "var(--c-ink-faint)" }}
    >
      <p className="text-[15px]">아래에 질문을 적으면 여기에 답이 펼쳐집니다.</p>
      <p className="mt-1 text-[13px]">
        오른쪽 도구로 직접 쓰고 그릴 수도 있습니다.
      </p>
    </div>
  );
}
