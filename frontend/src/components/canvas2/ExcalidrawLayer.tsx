"use client";

/**
 * 그리기 레이어 (D120). Excalidraw를 감싸고 기본 UI를 전부 걷어낸다.
 *
 * SSR을 끄는 이유: Excalidraw는 마운트 시 window/document를 직접 만진다.
 * `dynamic(..., { ssr: false })`가 아니면 빌드는 되지만 런타임에 죽는다.
 *
 * 번들이 크다(개발 빌드 실측 ~520KB). 캔버스 페이지에서만 로드되도록
 * 반드시 이 컴포넌트를 통해서만 임포트한다 — 홈·교사·관리자 화면에 끌려
 * 들어가면 안 된다.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef } from "react";
import "@excalidraw/excalidraw/index.css";
import type { DrawingScene } from "@/lib/api/canvas";
import type { ExcalidrawApi, ExcalidrawElementLike } from "@/lib/canvas2/useExcalidrawBridge";

const Excalidraw = dynamic(
  async () => (await import("@excalidraw/excalidraw")).Excalidraw,
  { ssr: false, loading: () => null },
);

/** 씬 저장 디바운스. 자유선 한 획이 수십 번의 onChange를 낸다. */
const SAVE_DEBOUNCE_MS = 1500;

interface Props {
  onApi: (api: ExcalidrawApi | null) => void;
  /** 최초 1회 복원할 씬. 이후 변경은 무시된다(Excalidraw가 씬을 소유한다). */
  initialScene: DrawingScene | null;
  /** 디바운스 후 호출. 저장은 호출부 책임. */
  onSceneCommit: (scene: DrawingScene) => void;
  /** 읽기 전용(교사 뷰 등) */
  viewOnly?: boolean;
}

export function ExcalidrawLayer({
  onApi,
  initialScene,
  onSceneCommit,
  viewOnly = false,
}: Props) {
  const timerRef = useRef<number | null>(null);
  // 최신 콜백을 ref에 담아 둔다 — 렌더 중에 쓰면 React Compiler가 막으므로
  // 이펙트에서 동기화한다. 디바운스 타이머가 옛 콜백을 붙잡는 걸 막는 게 목적이다.
  const commitRef = useRef(onSceneCommit);
  useEffect(() => {
    commitRef.current = onSceneCommit;
  }, [onSceneCommit]);

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElementLike[], _state: unknown, files: unknown) => {
      if (viewOnly) return;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        commitRef.current({
          elements: elements.filter((e) => !e.isDeleted) as unknown[],
          files: (files ?? {}) as Record<string, unknown>,
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [viewOnly],
  );

  // 언마운트 직전에 대기 중인 저장을 흘려보낸다 — 마지막 획이 사라지면 안 된다.
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="absolute inset-0" data-canvas-draw-layer>
      <Excalidraw
        excalidrawAPI={(api: unknown) => onApi(api as ExcalidrawApi)}
        onChange={handleChange}
        viewModeEnabled={viewOnly}
        initialData={{
          elements: (initialScene?.elements ?? []) as never,
          files: (initialScene?.files ?? {}) as never,
          appState: {
            viewBackgroundColor: "transparent",
            currentItemStrokeColor: "#2b2620",
            currentItemRoughness: 1,
            currentItemStrokeWidth: 2,
          },
          scrollToContent: false,
        }}
        // 기본 UI 전면 제거 — 우리 도구 레일이 대신한다.
        // zenMode로 대부분 사라지고, 남는 조각은 globals.css가 마저 숨긴다.
        zenModeEnabled
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false,
            clearCanvas: false,
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            export: false,
            toggleTheme: false,
          },
        }}
      />
    </div>
  );
}
