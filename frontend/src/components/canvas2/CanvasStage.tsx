"use client";

/**
 * 캔버스 셸 (D120) — 그리기 레이어 + 아이템 오버레이 + 도구 레일을 겹친다.
 *
 * ```
 * ┌─ .canvas2 (relative, overflow hidden) ───────────────────┐
 * │  ┌ DotGrid (변환 평면 안 — 팬을 따라간다) ─────────────┐ │
 * │  ┌ ExcalidrawLayer (팬/줌 소유, 그림 렌더) ────────────┐ │
 * │  ┌ .c2-overlay (pointer-events:none) ──────────────────┐ │
 * │  │   transform: translate(sx*z, sy*z) scale(z)          │ │
 * │  │   children: 아이템 · 연결선                           │ │
 * │  └──────────────────────────────────────────────────────┘ │
 * │  ToolRail · 상단/하단 UI  ← 화면 고정(변환 밖)            │
 * └───────────────────────────────────────────────────────────┘
 * ```
 *
 * 오버레이 컨테이너는 `pointer-events:none`이고 **아이템만** `auto`다.
 * 그리기 도구가 활성이면 아이템도 `none`이 되어 글 위에도 선을 그을 수 있다.
 */

import { useCallback, useEffect, useRef } from "react";
import { useCoarsePointer } from "@/lib/canvas2/coarsePointer";
import { useTouchNavigate } from "@/lib/canvas2/useTouchNavigate";
// 캔버스 손글씨 @font-face (D164). **여기서** 임포트하는 이유는 unicode-range
// 목록이 gzip 13KB이기 때문이다 — globals.css에 넣으면 로그인·홈·관리자 화면도
// 그걸 받는다. 폰트가 캔버스 전용이니 CSS도 캔버스 라우트 청크에만 둔다.
import "./hand-font.css";
import type { DrawingScene } from "@/lib/api/canvas";
import type { Camera, ToolName } from "@/lib/canvas2/types";
import type { ExcalidrawElementLike } from "@/lib/canvas2/useExcalidrawBridge";
import type { Bridge } from "@/lib/canvas2/useExcalidrawBridge";
import {
  useCameraFrame,
  useMiddleDragPan,
  useWheelForwarding,
} from "@/lib/canvas2/useExcalidrawBridge";
import { ExcalidrawLayer } from "./ExcalidrawLayer";
import { ToolRail } from "./ToolRail";

/** 도트 그리드 간격(world px). 줌에 따라 화면상 간격이 변한다. */
const GRID = 28;
/**
 * 이보다 작게 끌면 올가미가 아니라 클릭으로 본다 — **화면 px**이다.
 *
 * world px로 재던 것이 버그였다. `toWorld`는 현재 카메라를 쓰는데, 카메라가
 * 아직 정착 중이면 **마우스가 가만히 있어도** 같은 화면 점이 다른 world 점으로
 * 바뀐다. 그러면 클릭이 빈 올가미로 둔갑해 선택이 통째로 지워졌다(실측: 글을
 * 고른 뒤 Shift로 도형을 더하려 하면 둘 다 사라짐). 줌이 작을수록 심하다 —
 * 배율 0.23에서는 6 world px이 화면 1.4px이라 거의 모든 클릭이 올가미가 된다.
 *
 * 클릭이냐 드래그냐는 입력 차원의 구분이므로 화면에서 재는 것이 옳다.
 */
const MARQUEE_MIN_PX = 5;
/**
 * Excalidraw의 선택 상태를 읽기 전에 기다리는 시간(ms).
 *
 * 저쪽은 pointerup 즉시가 아니라 조금 뒤에 선택을 비운다 — **실측 31ms**
 * (빈 곳 클릭 후 선택 표시가 사라진 시점, 약 2프레임). 한 프레임(16ms)만
 * 기다리면 옛 선택을 보고 "도형을 눌렀다"고 오판해 **빈 곳을 눌러도 선택이
 * 안 풀린다.** 여유를 두되 사람이 느끼지 못할 만큼만.
 */
const SELECTION_SETTLE_MS = 90;
/** 도형을 "집었다"고 볼 화면 반경(px). Excalidraw의 잡기 여유와 비슷하게. */
const GRAB_TOLERANCE_PX = 10;

interface Props {
  bridge: Bridge;
  initialScene: DrawingScene | null;
  /** 씬이 도착한 시점을 나타내는 키. 바뀌면 그리기 레이어만 리마운트된다. */
  sceneKey: string | null;
  /** 그리기 레이어 마운트 시 적용할 카메라. */
  initialCamera?: { scrollX: number; scrollY: number; zoom: number };
  onSceneCommit: (scene: DrawingScene) => void;
  /** 씬이 방금 바뀌었다 — 디바운스 없이(D176: 질문 필기 획 세기). */
  onSceneChange?: (elements: readonly ExcalidrawElementLike[]) => void;
  /** 글쓰기 도구로 빈 캔버스를 클릭했을 때 — world 좌표를 준다. */
  onCanvasClick?: (world: { x: number; y: number }) => void;
  /** 그 외 도구로 빈 캔버스를 클릭했을 때 — 선택 해제용. */
  onBackgroundClick?: () => void;
  /**
   * 선택 도구로 빈 곳을 끌었을 때 — 그 world 사각형에 걸친 아이템을 고른다.
   * `add`면 기존 선택에 더한다(Shift).
   */
  onMarquee?: (rect: { x: number; y: number; w: number; h: number }, add: boolean) => void;
  /**
   * 도형을 끄는 동안(Excalidraw가 도형을 옮긴다) world 이동량을 알린다.
   * 함께 선택된 우리 글도 같이 따라가야 한다. `done`이면 마지막 호출이다.
   */
  onShapeDrag?: (dx: number, dy: number, done: boolean) => void;
  viewOnly?: boolean;
  /** 질문하는 펜을 쓰는 중 (D176) — 도구 단축키를 재운다. */
  penWriting?: boolean;
  /** 지금 열린 대화 id. 화면에 드러내 전환 완료를 밖에서 알 수 있게 한다. */
  sessionId?: string | null;
  /**
   * 도구를 고를 때 부모가 함께 할 일이 있으면 여기로 받는다 (D176: 질문 필기
   * 단계 되돌리기). 없으면 브리지로 바로 간다.
   */
  onToolSelect?: (tool: ToolName) => void;
  /** 화면 고정 UI(상단바·입력창 등) */
  chrome?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * 카드 수정 도구의 **별 포인터** (D180).
 *
 * 도구가 켜졌다는 것이 포인터에서 바로 읽혀야 한다 — 이 도구는 끌면 관계가
 * 끊기므로, 학생이 "지금 어느 도구지?"를 레일에서 확인해야 한다면 이미 늦다.
 *
 * SVG를 data URI로 박는다. 파일로 두면 첫 사용에서 한 프레임 기본 커서가
 * 보이고(네트워크 왕복), 커서는 그 한 프레임이 그대로 눈에 띈다. 흰 테두리를
 * 두른 이유는 캔버스가 밝은 종이색이라 검은 별만으로는 카드 위에서 묻히기
 * 때문이다.
 *
 * 마지막 `auto`는 폴백이다 — 커서 이미지를 못 읽는 환경에서 포인터가 아예
 * 사라지면 안 된다.
 */
const STAR_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' +
    '<path d="M13 2.6 15.7 9.3 22.4 12 15.7 14.7 13 21.4 10.3 14.7 3.6 12 10.3 9.3Z" ' +
    'fill="#e0a32e" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>' +
    "</svg>",
);
/** 별의 **가운데**가 포인터다 — 꼭짓점을 기준으로 삼으면 어디를 집었는지 안 맞는다. */
const STAR_CURSOR = `url("data:image/svg+xml,${STAR_SVG}") 13 13, auto`;

function cursorFor(tool: ToolName): string | undefined {
  if (tool === "note") return "text";
  if (tool === "cardedit") return STAR_CURSOR;
  return undefined;
}

export function CanvasStage({
  bridge,
  initialScene,
  sceneKey,
  initialCamera,
  onSceneCommit,
  onSceneChange,
  onCanvasClick,
  onBackgroundClick,
  onMarquee,
  onShapeDrag,
  viewOnly = false,
  penWriting = false,
  sessionId = null,
  onToolSelect,
  chrome,
  children,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const { activeTool, overlayInteractive, subscribeFrame, panByScreen } = bridge;

  useWheelForwarding(overlayRef, overlayInteractive);
  useMiddleDragPan(rootRef, panByScreen);

  /**
   * 손가락 기기에서는 **기본 도구가 화면 이동**이다 (D208, 사용자 지시).
   *
   * 한 번만 바꾼다 — 그 뒤 학생이 고른 도구를 되돌리면 도구 레일이 눌리지
   * 않는 것처럼 보인다. `coarse`는 붙은 뒤 한 번 true가 되므로 이 이펙트도
   * 그때 한 번 돈다.
   */
  /**
   * 손가락 기기는 **화면 이동 도구로 시작한다** (D208).
   *
   * 도구는 Excalidraw의 initialData로만 확실히 정해진다. 그래서 기기 종류가
   * **정해질 때까지 그 레이어를 아예 안 그린다**(D209) — 리마운트로 고치면
   * 캔버스를 통째로 다시 세우는 비용을 문다. `ssr: false`라 어차피
   * 하이드레이션 뒤에 마운트되므로 기다리는 비용은 없다.
   */
  const coarse = useCoarsePointer();

  /**
   * 오버레이 변환 — **React가 아니라 여기가 소유한다.**
   *
   * style prop으로 두면 팬 프레임마다 리렌더가 필요하고, 그 리렌더가 아이템
   * 트리와 미니맵을 통째로 다시 돌린다. 여기서 DOM을 직접 고치면 팬 중
   * React는 한 번도 돌지 않는다.
   */
  useCameraFrame(
    subscribeFrame,
    overlayRef,
    useCallback((el: HTMLElement, c: Camera) => {
      el.style.transform = `translate(${c.scrollX * c.zoom}px, ${
        c.scrollY * c.zoom
      }px) scale(${c.zoom})`;
    }, []),
  );

  // 격자도 같은 이유로 직접 고친다. 줌아웃이 심하면 점이 뭉쳐 회색 면이
  // 되므로 그 아래로는 숨긴다.
  useCameraFrame(
    subscribeFrame,
    gridRef,
    useCallback((el: HTMLElement, c: Camera) => {
      const step = GRID * c.zoom;
      el.style.opacity = step < 9 ? "0" : "1";
      el.style.backgroundSize = `${step}px ${step}px`;
      el.style.backgroundPosition = `${c.scrollX * c.zoom}px ${c.scrollY * c.zoom}px`;
    }, []),
  );

  // 빈 캔버스에서의 포인터.
  //
  //   글쓰기 도구  → 그 자리에 새 글을 만든다. Excalidraw가 먼저 먹지 않도록
  //                  **캡처 단계에서** 가로채고 전파를 끊는다.
  //   선택 도구    → 끌면 올가미(marquee), 그냥 누르면 선택 해제.
  //   그 외        → 아무것도 하지 않는다. 전파도 끊지 않는다(팬·그리기가
  //                  계속 돌아야 한다).
  const { toWorld, hasElementSelection, elementAtPoint, cameraRef } = bridge;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    /** 올가미 시작점. 화면·world를 함께 들고 있는다. null이면 올가미 중이 아니다. */
    let from: { sx: number; sy: number; wx: number; wy: number } | null = null;
    /** 도형을 끄는 중이면 그 시작 화면 좌표. 우리 글도 같이 옮긴다. */
    let shapeFrom: { sx: number; sy: number } | null = null;

    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // 우리 UI(도구 레일·아이템) 위 클릭은 그쪽에 맡긴다.
      if (t.closest("[data-no-pan]") || t.closest("[data-canvas-item]")) return;
      // 왼쪽 버튼만. 중클릭은 팬(useMiddleDragPan)이 가져간다.
      if (e.button !== 0) return;
      /**
       * 손가락·펜은 **여기서 처리하지 않는다** (D208).
       *
       * 끌기의 뜻이 반대다 — PC는 올가미, 손가락은 화면 이동이다. 두 규칙이
       * 같은 이벤트를 보면 손가락으로 끌 때 화면이 움직이면서 선택 상자까지
       * 잡힌다. `useTouchNavigate`가 캡처 단계에서 먼저 가져간다.
       */
      if (coarse && e.pointerType !== "mouse") return;

      if (activeTool === "note") {
        e.preventDefault();
        e.stopPropagation();
        onCanvasClick?.(toWorld(e.clientX, e.clientY, root.getBoundingClientRect()));
        return;
      }
      // 팬·그리기 중에는 선택을 건드리지 않는다 — 화면을 옮길 때마다 선택이
      // 풀리면 아이템을 고르고 이동해서 보려는 동작이 불가능하다.
      //
      // **전파는 끊지 않는다.** Excalidraw가 같은 드래그로 자기 도형을 올가미로
      // 잡아야 한다 — 그래야 도형과 글이 **한 번에** 묶인다(사용자 요구).
      // 올가미 사각형도 저쪽이 그린다. 우리가 하나 더 그리면 두 겹이 된다.
      if (activeTool === "selection") {
        const w = toWorld(e.clientX, e.clientY, root.getBoundingClientRect());
        /**
         * **도형 위에서 시작한 드래그는 올가미가 아니다** — 그 도형을 옮기는
         * 중이다(Excalidraw가 처리한다).
         *
         * 이걸 가리지 않으면 도형을 끌 때마다 우리가 올가미로 오해하고, 그
         * 사각형에 걸린 글이 없으면 **선택을 통째로 비운다.** 실측: 글+도형을
         * 함께 고른 뒤 도형을 끌면 글 선택이 1 → 0으로 사라졌다.
         *
         * 판정은 잉크 기준이다(D141) — 속이 빈 도형의 가운데에서 시작한
         * 드래그는 Excalidraw도 잡지 않으므로 올가미가 맞다.
         */
        const tol = GRAB_TOLERANCE_PX / (cameraRef.current.zoom || 1);
        if (elementAtPoint(w, tol)) {
          // 함께 선택된 우리 글도 같은 양만큼 따라가게 이동량을 흘린다.
          shapeFrom = { sx: e.clientX, sy: e.clientY };
          return;
        }
        from = { sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y };
      }
    };

    const onShapeMove = (e: PointerEvent) => {
      if (!shapeFrom) return;
      const z = cameraRef.current.zoom || 1;
      onShapeDrag?.((e.clientX - shapeFrom.sx) / z, (e.clientY - shapeFrom.sy) / z, false);
    };

    const onUp = (e: PointerEvent) => {
      if (shapeFrom) {
        const z = cameraRef.current.zoom || 1;
        const dx = (e.clientX - shapeFrom.sx) / z;
        const dy = (e.clientY - shapeFrom.sy) / z;
        shapeFrom = null;
        onShapeDrag?.(dx, dy, true);
      }
      const f = from;
      from = null;
      if (!f) return;
      // **화면에서 판정한다.** world로 재면 카메라가 움직이는 동안의 클릭이
      // 올가미로 둔갑한다(위 상수 주석 참고).
      const movedPx = Math.hypot(e.clientX - f.sx, e.clientY - f.sy);
      if (movedPx < MARQUEE_MIN_PX) {
        /**
         * 끌지 않았으면 클릭이다. 그런데 **빈 곳을 눌렀을 때만** 선택을 푼다.
         *
         * 예전에는 무조건 풀었다. 그래서 글을 고른 뒤 Shift로 도형을 더하려고
         * 누르면, 그 클릭이 캔버스로 가면서 우리 글 선택이 통째로 날아갔다
         * (실측: 도형 클릭 → Shift+글 = 함께 선택됨, 반대 순서 = 둘 다 사라짐).
         *
         * 무엇이 눌렸는지는 Excalidraw만 안다 — 히트 테스트 API가 공개돼 있지
         * 않으므로 **다음 프레임에 저쪽 선택을 보고** 판단한다. 도형이 잡혔으면
         * 빈 곳이 아니었다는 뜻이다.
         *
         * Shift/⌘를 누른 채면 애초에 "더하겠다"는 뜻이므로 절대 풀지 않는다.
         */
        if (e.shiftKey || e.metaKey || e.ctrlKey) return;
        window.setTimeout(() => {
          if (!hasElementSelection()) onBackgroundClick?.();
        }, SELECTION_SETTLE_MS);
        return;
      }
      const to = toWorld(e.clientX, e.clientY, root.getBoundingClientRect());
      onMarquee?.(
        {
          x: Math.min(f.wx, to.x),
          y: Math.min(f.wy, to.y),
          w: Math.abs(to.x - f.wx),
          h: Math.abs(to.y - f.wy),
        },
        e.shiftKey,
      );
    };

    root.addEventListener("pointerdown", onDown, { capture: true });
    // window에서 받는다 — 캔버스 밖에서 손을 떼도 올가미가 끝나야 한다.
    window.addEventListener("pointermove", onShapeMove, { capture: true });
    window.addEventListener("pointerup", onUp, { capture: true });
    return () => {
      root.removeEventListener("pointerdown", onDown, { capture: true });
      window.removeEventListener("pointermove", onShapeMove, { capture: true });
      window.removeEventListener("pointerup", onUp, { capture: true });
    };
  }, [activeTool, coarse, onCanvasClick, onBackgroundClick, onMarquee, toWorld, hasElementSelection, elementAtPoint, cameraRef, onShapeDrag]);

  /** 손가락: 끌면 이동, 길게 누르면 선택 상자 (D208). */
  useTouchNavigate({
    rootRef,
    activeTool,
    enabled: coarse === true,
    panByScreen,
    toWorld,
    onMarquee,
    onBackgroundClick,
  });

  return (
    <div
      ref={rootRef}
      className="canvas2 relative h-full w-full overflow-hidden"
      /**
       * 지금 열린 대화 (2026-08-05 플로우 점검).
       *
       * "어느 대화를 보고 있나"가 화면에서 **관찰 불가능**했다. 그래서 대화를
       * 새로 만든 직후에 파일을 붙이면 앞 대화로 들어가는 것을 아무도 못 봤다
       * (실측: 새 대화로 바꾼 뒤 붙인 파일이 이전 세션에 달렸고, 화면에는
       * 아무 표시도 없었다). 전환이 끝났는지 밖에서 알 수 있어야 한다.
       */
      data-session={sessionId ?? ""}
      style={{ cursor: cursorFor(activeTool) }}
    >
      {/* 격자는 변환 평면 **밖**에 두고 background-position으로 흉내 낸다 —
          평면 안에 두면 scale(z)에 따라 점 자체가 커져 줌아웃에서 뭉개진다.
          위치·간격은 useCameraFrame이 DOM에 직접 쓴다. */}
      <div ref={gridRef} className="canvas2-grid" />

      {coarse === null ? null : (
      <ExcalidrawLayer
        // 손가락 기기는 화면 이동으로 시작한다 (D208).
        initialTool={coarse ? "hand" : "selection"}
        key={sceneKey ?? "none"}
        onApi={bridge.setApi}
        initialScene={initialScene}
        onSceneCommit={onSceneCommit}
        onSceneChange={onSceneChange}
        viewOnly={viewOnly}
        initialCamera={initialCamera}
      />
      )}

      <div
        ref={overlayRef}
        className="absolute inset-0"
        style={{
          pointerEvents: "none",
          // transform은 여기서 주지 않는다 — useCameraFrame이 소유한다.
          // React가 style로도 쓰면 팬 중 리렌더가 한 프레임 옛 값으로 되돌린다.
          transformOrigin: "0 0",
          // 팬/줌마다 합성 레이어를 다시 만들지 않게 미리 알린다.
          willChange: "transform",
          /**
           * **Excalidraw 캔버스가 z-index: 2다.** 우리 오버레이는 DOM에서 뒤에
           * 있지만 z-index가 없어서, 히트 테스트에서 캔버스가 아이템을 통째로
           * 덮었다 — 실제 마우스로는 글을 클릭할 수도, 끌 수도 없었다.
           *
           * 합성 이벤트(`el.dispatchEvent`)는 히트 테스트를 건너뛰므로 자동
           * 검증에서 이 문제가 드러나지 않았다. 진짜 마우스로 눌러 봐야 보인다.
           */
          zIndex: 3,
          // 자식(아이템)이 pointer-events:auto를 켤지 여기서 정한다.
          ["--c2-item-events" as string]: overlayInteractive ? "auto" : "none",
        }}
      >
        {children}
      </div>

      {chrome}

      {!viewOnly && (
        <ToolRail
          paused={penWriting}
          active={activeTool}
          onSelect={onToolSelect ?? bridge.setTool}
          setDrawStyle={bridge.setDrawStyle}
        />
      )}
    </div>
  );
}


