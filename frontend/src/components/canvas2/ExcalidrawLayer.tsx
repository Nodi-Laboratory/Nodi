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

/** 팔레트의 본문 잉크 색을 실제 값으로 읽는다(Excalidraw는 var()를 못 받는다). */
function inkColor(): string {
  if (typeof document === "undefined") return "#221e17";
  const el = document.querySelector(".canvas2");
  const v = el ? getComputedStyle(el).getPropertyValue("--c-ink").trim() : "";
  return v || "#221e17";
}

interface Props {
  onApi: (api: ExcalidrawApi | null) => void;
  /** 최초 1회 복원할 씬. 이후 변경은 무시된다(Excalidraw가 씬을 소유한다). */
  initialScene: DrawingScene | null;
  /** 디바운스 후 호출. 저장은 호출부 책임. */
  onSceneCommit: (scene: DrawingScene) => void;
  /** 읽기 전용(교사 뷰 등) */
  viewOnly?: boolean;
  /**
   * 마운트 시 적용할 카메라.
   *
   * **명령형(updateScene)으로 밀지 않는다.** 마운트 직후에는 api가 아직 없고,
   * 씬이 도착하면 이 컴포넌트가 리마운트되면서 스크롤이 0으로 돌아간다 —
   * 그 사이 어디에 끼워 넣어도 경합이 남는다. initialData는 마운트 시점에
   * 확정적으로 적용되므로 경합 자체가 없다.
   */
  initialCamera?: { scrollX: number; scrollY: number; zoom: number };
}

export function ExcalidrawLayer({
  onApi,
  initialScene,
  onSceneCommit,
  viewOnly = false,
  initialCamera,
}: Props) {
  const timerRef = useRef<number | null>(null);
  // 최신 콜백을 ref에 담아 둔다 — 렌더 중에 쓰면 React Compiler가 막으므로
  // 이펙트에서 동기화한다. 디바운스 타이머가 옛 콜백을 붙잡는 걸 막는 게 목적이다.
  const commitRef = useRef(onSceneCommit);
  useEffect(() => {
    commitRef.current = onSceneCommit;
  }, [onSceneCommit]);

  /**
   * 마지막으로 저장(또는 불러온) 씬의 서명.
   *
   * **바뀌지 않았으면 저장하지 않는다.** `onChange`는 마운트·팬·줌에도 터지는데,
   * 이 엔드포인트는 씬을 통째로 교체한다(PUT). 그래서 아무것도 안 그린 탭이
   * 다른 탭이 방금 그린 것을 덮어쓸 수 있다 — 같은 세션을 두 탭에서 열면
   * 나중에 타이머가 도는 쪽이 이긴다. 실측으로 이 경로를 밟았다(브라우저를
   * 열어 둔 채 씬을 밖에서 바꾸니 곧 빈 배열로 되돌아갔다).
   */
  const savedSigRef = useRef<string>("");

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElementLike[], _state: unknown, files: unknown) => {
      if (viewOnly) return;
      const live = elements.filter((e) => !e.isDeleted);
      // version은 요소를 고칠 때마다 오른다 — 좌표만 비교하면 색·굵기 변경을 놓친다.
      const sig = live.map((e) => `${e.id}:${e.version ?? 0}`).join("|");
      if (sig === savedSigRef.current) return;

      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        savedSigRef.current = sig;
        commitRef.current({
          elements: live as unknown[],
          files: (files ?? {}) as Record<string, unknown>,
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [viewOnly],
  );

  // 불러온 씬을 "이미 저장된 것"으로 기록해 둔다 — 안 하면 마운트 직후의
  // onChange가 같은 내용을 한 번 더 쓴다(무해하지만 불필요한 왕복이고, 그
  // 왕복이 다른 탭의 작업을 덮는다).
  useEffect(() => {
    const els = (initialScene?.elements ?? []) as ExcalidrawElementLike[];
    savedSigRef.current = els
      .filter((e) => !e.isDeleted)
      .map((e) => `${e.id}:${e.version ?? 0}`)
      .join("|");
  }, [initialScene]);

  // 언마운트 정리.
  //
  // **`onApi(null)`을 반드시 부른다.** 이 컴포넌트는 씬이 도착하면 key가 바뀌며
  // 리마운트되는데, 그때 알려 주지 않으면 상위가 죽은 Excalidraw의 api를 계속
  // 들고 있는다. 그 api로 `updateScene`을 부르면 조용히 아무 일도 일어나지
  // 않는다 — 실측으로 초기 카메라가 통째로 버려졌다(좌측 여백이 안 잡혀 열
  // 라벨이 사이드바에 잘렸다).
  const apiRef = useRef(onApi);
  useEffect(() => {
    apiRef.current = onApi;
  }, [onApi]);
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      apiRef.current(null);
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
            ...(initialCamera
              ? {
                  scrollX: initialCamera.scrollX,
                  scrollY: initialCamera.scrollY,
                  // NormalizedZoomValue는 브랜드 타입이다 — 런타임에는 그냥
                  // 숫자라 캐스팅으로 넘긴다.
                  zoom: { value: initialCamera.zoom as unknown as never },
                }
              : {}),
            // 따뜻한 먹. 학생의 자국을 틸로 강제하지 않는다 — 기본 색상
            // 패널을 숨겼으므로 강제하면 색을 고를 방법이 아예 없어진다.
            //
            // Excalidraw는 CSS 변수를 받지 못해 실제 값이 필요하다. 팔레트에서
            // 읽어 오므로 --c-ink를 고치면 여기도 따라온다 — 예전에는 #2e2a20이
            // 박혀 있어 팔레트와 어긋난 별개 값이었다.
            currentItemStrokeColor: inkColor(),
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
