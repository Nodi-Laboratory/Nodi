"use client";

/**
 * Excalidraw와 우리 오버레이 사이의 유일한 창구 (D120).
 *
 * **다른 파일은 Excalidraw API를 직접 만지지 않는다.** 여기 한 곳에 모아 두면
 * 버전을 올리거나 그리기 엔진을 바꿀 때 고칠 자리가 하나다.
 *
 * ## 왜 Excalidraw가 뷰포트를 소유하는가
 *
 * 팬/줌을 우리가 소유하면 두 입력계가 싸운다(스페이스 드래그·핀치·트랙패드
 * 관성이 양쪽에 다 있다). Excalidraw의 카메라는 이미 훌륭하므로 그쪽에
 * 맡기고, 우리 오버레이가 그 상태를 따라간다.
 *
 * ## 좌표 규약 (실측 확인 2026-07-30)
 *
 *     screen = (world + scroll) * zoom
 *     world  = screen / zoom - scroll
 *
 * 오버레이에 `translate(scrollX*zoom, scrollY*zoom) scale(zoom)`(origin 0 0)을
 * 걸고 자식을 `left:worldX; top:worldY`로 두면 정확히 일치한다
 * (실측: world(120,120) · scroll(0,−181.8) · zoom 1.1 → 화면 132/−68,
 *  계산값 132/−67.98).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Camera, DrawStyle, Rect, ToolName } from "./types";
import { isPassThroughTool } from "./types";
import { inflate } from "./rect";
import { boundsOf, elementHitsRect } from "./elementHit";

/** 우리가 쓰는 것만 추린 Excalidraw API 표면. */
export interface ExcalidrawApi {
  getAppState: () => {
    scrollX: number;
    scrollY: number;
    zoom: { value: number };
    width: number;
    height: number;
    /** 현재 도구. **이것이 진실이다** — 우리 state를 따로 두면 어긋난다. */
    activeTool: { type: string; locked?: boolean };
    /** 편집 중인 Excalidraw 텍스트 요소 id. 있으면 키 입력을 가로채면 안 된다. */
    editingTextElement?: { id: string } | null;
    /** 지금 선택된 도형들. 올가미 결과를 덮어쓸 때 기준이 된다. */
    selectedElementIds?: Record<string, boolean>;
  };
  getSceneElements: () => readonly ExcalidrawElementLike[];
  updateScene: (data: {
    appState?: Record<string, unknown>;
    /** 씬 전체를 갈아 끼운다 — 질문 필기를 지울 때 쓴다(D176). */
    elements?: readonly ExcalidrawElementLike[];
  }) => void;
  setActiveTool: (tool: { type: string; locked?: boolean }) => void;
  scrollToContent?: (target?: unknown, opts?: unknown) => void;
  history?: { clear: () => void };
}

export interface ExcalidrawElementLike {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  /** 요소를 고칠 때마다 오른다. 변경 감지에 쓴다(ExcalidrawLayer). */
  version?: number;
  /** 그룹 소속. 하나가 잡히면 같은 그룹 전체가 잡혀야 한다. */
  groupIds?: readonly string[];
  // --- 올가미 히트 테스트용 (elementHit.ts) ---
  type?: string;
  /** 회전 각(라디안). */
  angle?: number;
  /** 선형 요소의 점들(요소 원점 기준 상대 좌표). */
  points?: readonly (readonly number[])[];
  /** 자유선의 점별 필압(0~1). 없으면 필압 없는 입력이다. */
  pressures?: readonly number[];
  /**
   * 우리가 요소에 얹는 표시 (D176: `customData.nodiAsk` — 질문 획).
   * Excalidraw가 저장·복원 때 그대로 들고 다닌다.
   */
  customData?: Record<string, unknown> | null;
  /** "transparent"면 속이 비었다 — 테두리만 몸이다. */
  backgroundColor?: string;
}

const IDENTITY: Camera = { scrollX: 0, scrollY: 0, zoom: 1 };

/** 우리 레일에 있는 도구 이름. Excalidraw가 그 밖의 도구를 켤 수도 있다. */
const KNOWN_TOOLS = new Set<string>([
  "selection",
  "hand",
  "freedraw",
  "rectangle",
  "ellipse",
  "arrow",
  "line",
  "eraser",
]);

/** 그림 요소를 장애물로 쓸 때 두르는 여백. 글이 선에 닿아 보이지 않게. */
export const OBSTACLE_PAD = 24;

export interface Bridge {
  api: ExcalidrawApi | null;
  setApi: (api: ExcalidrawApi | null) => void;
  /**
   * 렌더용 카메라. **팬 중에는 갱신되지 않는다** — 멈춘 뒤 한 번만 올라온다.
   * 매 프레임 따라가야 하는 것(오버레이 변환·격자)은 `subscribeFrame`을 쓴다.
   */
  camera: Camera;
  /** 리렌더 없이 최신 값을 읽는 용도(rAF 루프·드래그 계산). */
  cameraRef: React.RefObject<Camera>;
  /**
   * 카메라가 움직인 프레임마다 부른다. React를 거치지 않고 DOM을 직접 고치는
   * 용도다 — 해지 함수를 돌려준다.
   */
  subscribeFrame: (cb: (c: Camera) => void) => () => void;
  /** 화면 픽셀만큼 화면을 민다(중클릭 팬). 감도 1:1. */
  panByScreen: (dx: number, dy: number) => void;
  activeTool: ToolName;
  setTool: (tool: ToolName) => void;
  /**
   * 다음에 그릴 것의 색·굵기·투명도를 정한다 (D150).
   *
   * 이미 그려 둔 요소는 건드리지 않는다 — Excalidraw의 `currentItem*`은
   * "앞으로 만들 요소의 기본값"이다. 학생이 색을 바꿔도 앞서 그은 선은
   * 그대로라는 뜻이고, 그게 필기구의 동작이다.
   */
  setDrawStyle: (style: DrawStyle) => void;
  /** 오버레이가 포인터 이벤트를 먹어야 하는가(선택·글쓰기 도구일 때만). */
  overlayInteractive: boolean;
  /** 그림 요소들의 바운딩 박스(패딩 포함) — 배치 엔진의 장애물. */
  getObstacles: () => Rect[];
  /**
   * 올가미 사각형에 **걸친** 도형을 고른다(Excalidraw 선택을 우리가 정한다).
   * `additive`면 기존 선택에 더한다.
   */
  selectElementsIn: (rect: Rect, additive: boolean) => void;
  /**
   * 이 world 점에 도형의 **몸**이 있나(잉크 기준, D141).
   * 올가미를 시작해도 되는 빈 곳인지 가리는 데 쓴다.
   */
  elementAtPoint: (p: { x: number; y: number }, tolerance: number) => boolean;
  /** 지금 Excalidraw 도형이 하나라도 선택돼 있나. */
  hasElementSelection: () => boolean;
  /** 도형 선택을 비운다(우리 글을 단독 선택할 때). */
  clearElementSelection: () => void;
  /** 카메라를 직접 설정(스프링·미니맵 이동용). */
  applyCamera: (c: Camera) => void;
  /** screen(클라이언트) 좌표 → world */
  toWorld: (clientX: number, clientY: number, rootRect: DOMRect) => { x: number; y: number };
}

export function useExcalidrawBridge(): Bridge {
  const [api, setApi] = useState<ExcalidrawApi | null>(null);
  const [camera, setCamera] = useState<Camera>(IDENTITY);
  const cameraRef = useRef<Camera>(IDENTITY);

  /**
   * 도구는 **Excalidraw가 소유한다.** 우리 state로 따로 들면 반드시 어긋난다 —
   * 도형을 하나 그리면 Excalidraw가 스스로 선택 도구로 돌아가는데(툴 락이
   * 꺼져 있을 때의 기본 동작) 우리 레일은 여전히 도형이 눌린 것으로 보였다.
   * 사용자가 지적한 문제가 정확히 이것이다.
   *
   * 'note'만 우리 도구다. Excalidraw에는 selection을 물려 두므로 appState만
   * 봐서는 구별할 수 없어, 마지막으로 note를 눌렀는지 따로 기억한다.
   */
  const [rawTool, setRawTool] = useState<string>("selection");
  const [noteMode, setNoteMode] = useState(false);
  /** 질문하는 펜(D176). note와 같은 처지 — appState만 봐서는 구별할 수 없다. */
  const [askMode, setAskMode] = useState(false);
  /**
   * 형광펜을 켰나 (D150). note와 같은 처지다 — Excalidraw에는 형광펜이
   * 없어서 자유선을 물려 두고 스타일만 바꾸므로, appState만 봐서는 펜과
   * 형광펜을 구별할 수 없다.
   */
  const [highlighting, setHighlighting] = useState(false);

  /**
   * 프레임 구독자 — 카메라가 움직일 때마다 DOM을 직접 고치는 쪽(오버레이 변환·
   * 격자)이 여기에 붙는다. ref에 담아 두므로 구독이 바뀌어도 rAF 루프를 다시
   * 세우지 않는다.
   */
  const frameSubs = useRef<Set<(c: Camera) => void>>(new Set());
  const subscribeFrame = useCallback((cb: (c: Camera) => void) => {
    frameSubs.current.add(cb);
    cb(cameraRef.current); // 붙는 즉시 현재 값으로 맞춘다
    return () => {
      frameSubs.current.delete(cb);
    };
  }, []);

  const emitFrame = useCallback((c: Camera) => {
    for (const cb of frameSubs.current) cb(c);
  }, []);

  /** React state에 마지막으로 올린 값. 팬 중에는 여기가 뒤처져 있는 게 정상이다. */
  const committedRef = useRef<Camera>(IDENTITY);

  // 카메라는 onChange가 아니라 rAF 폴링으로 읽는다.
  //
  // onChange는 드래그 중 과도하게 터지고, 스크롤만 바뀌었을 때도 elements
  // 배열을 통째로 넘긴다(우리는 안 쓴다). 폴링은 프레임당 정확히 1회다.
  //
  // ## 팬 중에는 setState를 하지 않는다
  //
  // 예전에는 값이 바뀔 때마다 setCamera를 불렀다. 그러면 팬 한 번에 프레임마다
  // CanvasWorkspace가 다시 돌고, 그때마다 미니맵이 전 아이템을 훑어 union·투영을
  // 다시 계산하고 연결선도 전부 다시 그렸다 — 사용자가 말한 "화면 이동이 답답하고
  // 느린 느낌"의 정체다. 화면이 손가락을 못 따라온다.
  //
  // 매 프레임 따라가야 하는 건 오버레이 변환과 격자 두 개뿐이고, 둘 다 DOM
  // 속성 하나다. 그건 구독자에게 직접 넘기고 **React state는 카메라가 멈춘
  // 뒤에 한 번만** 올린다. 미니맵의 뷰포트 사각형이 팬 중에 안 움직이는 건
  // 감수한다 — 멈추면 맞는다.
  useEffect(() => {
    if (!api) return;
    let raf = 0;
    // 몇 프레임 연속 가만히 있었나. 1프레임만 보면 스프링이 미세하게 흔들릴 때
    // 멈춤으로 오판해 매 프레임 커밋하게 된다.
    let still = 0;
    const tick = () => {
      const s = api.getAppState();
      const prev = cameraRef.current;
      const next = { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value };
      const moved =
        prev.scrollX !== next.scrollX ||
        prev.scrollY !== next.scrollY ||
        prev.zoom !== next.zoom;

      if (moved) {
        cameraRef.current = next;
        emitFrame(next);
        still = 0;
      } else {
        still++;
      }

      const c = committedRef.current;
      const stale =
        c.scrollX !== next.scrollX || c.scrollY !== next.scrollY || c.zoom !== next.zoom;
      // 줌은 즉시 올린다 — 배율 표시·아이템 드래그 환산이 줌에 걸려 있어서
      // 늦으면 눈에 보이게 어긋난다. 스크롤은 멈춘 뒤에.
      if (stale && (c.zoom !== next.zoom || still >= 2)) {
        committedRef.current = next;
        setCamera(next);
      }

      // 도구도 같은 루프에서 따라간다. Excalidraw가 스스로 도구를 바꿀 때
      // (도형 하나 그린 뒤, Esc, 자체 단축키) 우리 레일이 즉시 맞춰진다.
      const t = s.activeTool?.type;
      if (t) {
        setRawTool((prevTool) => (prevTool === t ? prevTool : t));
        // selection으로 돌아갔으면 note 모드도 끝난 것이다.
        if (t !== "selection") setNoteMode(false);
        // 질문하는 펜은 **자유선**을 물려 쓴다(D176) — 기존 펜이 자연스럽게
        // 써지기 때문이다. 그래서 자유선을 벗어났을 때만 끝난 것으로 본다.
        if (t !== "freedraw") setAskMode(false);
        // 자유선을 벗어났으면 형광펜도 끝났다(도형 하나 그린 뒤 Excalidraw가
        // 스스로 선택 도구로 돌아가는 경우까지 여기서 잡힌다).
        if (t !== "freedraw") setHighlighting(false);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [api, emitFrame]);

  const setTool = useCallback(
    (tool: ToolName) => {
      setNoteMode(tool === "note");
      setAskMode(tool === "askpen");
      setHighlighting(tool === "highlighter");
      // 우리 도구 둘은 Excalidraw의 다른 도구를 물려 쓴다.
      //   note        선택 도구 — 캔버스 클릭을 오버레이가 가로챈다
      //   highlighter 자유선   — 스타일만 반투명·굵게 바꾼다
      const type =
        tool === "note"
          ? "selection"
          : tool === "highlighter" || tool === "askpen"
            ? "freedraw"
            : tool;
      setRawTool(type);
      api?.setActiveTool({ type });
    },
    [api],
  );

  const setDrawStyle = useCallback(
    (s: DrawStyle) => {
      api?.updateScene({
        appState: {
          currentItemStrokeColor: s.strokeColor,
          currentItemOpacity: s.opacity,
          currentItemStrokeWidth: s.strokeWidth,
          currentItemRoughness: s.roughness,
          currentItemStrokeStyle: "solid",
        },
      });
    },
    [api],
  );

  /**
   * 화면에 보여 줄 도구.
   *
   * Excalidraw의 도구 이름을 우리 ToolName으로 좁힌다. 모르는 이름
   * (image·frame·laser 등 우리 레일에 없는 것)은 selection으로 떨어뜨린다 —
   * 레일에 아무것도 눌리지 않은 상태로 두면 학생이 무엇이 켜졌는지 모른다.
   */
  const activeTool: ToolName = askMode && rawTool === "freedraw"
    ? "askpen"
    : noteMode
      ? "note"
      : highlighting && rawTool === "freedraw"
        ? "highlighter"
        : KNOWN_TOOLS.has(rawTool)
          ? (rawTool as ToolName)
          : "selection";

  const getObstacles = useCallback((): Rect[] => {
    if (!api) return [];
    const out: Rect[] = [];
    for (const el of api.getSceneElements()) {
      if (el.isDeleted) continue;
      // 음수 폭/높이(역방향으로 그린 도형)를 정규화한다 — 그대로 두면
      // 사각형 교차 판정이 전부 거짓이 되어 장애물이 무시된다.
      out.push(inflate(boundsOf(el), OBSTACLE_PAD));
    }
    return out;
  }, [api]);

  /**
   * 올가미 결과를 **우리가 정해서 Excalidraw에 밀어 넣는다**.
   *
   * 사용자 요구는 "모든 요소가 동일하게 선택되어야 한다"인데, Excalidraw의
   * 올가미는 **완전히 감싸야** 도형을 잡는다(실측). 그 규칙은 저쪽 내부라
   * 바꿀 수 없어서, 대신 선택 **결과**를 덮어쓴다.
   *
   * 다음 프레임에 적용하는 것이 핵심이다. 우리 pointerup 리스너는 window
   * 캡처라 Excalidraw보다 **먼저** 돈다 — 같은 프레임에 쓰면 저쪽이 자기
   * 판정으로 곧바로 덮어쓴다.
   *
   * 그룹은 통째로 잡는다. 한 조각만 선택되면 이동·삭제가 그룹을 쪼갠다.
   */
  const selectElementsIn = useCallback(
    (rect: Rect, additive: boolean) => {
      if (!api) return;
      requestAnimationFrame(() => {
        const els = api.getSceneElements().filter((e) => !e.isDeleted);
        // **바운딩 박스가 아니라 실제 잉크로 판정한다**(D141). 박스로 보면
        // 속이 빈 도형의 가운데나 대각선의 빈 모서리를 끌어도 잡혔다.
        const hit = els.filter((e) => elementHitsRect(e, rect));

        const groups = new Set(hit.flatMap((e) => e.groupIds ?? []));
        const ids = new Set(hit.map((e) => e.id));
        if (groups.size) {
          for (const e of els) {
            if ((e.groupIds ?? []).some((g) => groups.has(g))) ids.add(e.id);
          }
        }

        const next: Record<string, boolean> = additive
          ? { ...(api.getAppState().selectedElementIds ?? {}) }
          : {};
        for (const id of ids) next[id] = true;
        api.updateScene({ appState: { selectedElementIds: next } });
      });
    },
    [api],
  );

  const applyCamera = useCallback(
    (c: Camera) => {
      if (!api) return;
      api.updateScene({
        appState: { scrollX: c.scrollX, scrollY: c.scrollY, zoom: { value: c.zoom } },
      });
      // **ref를 올리고 구독자에게 곧장 넘긴다.**
      //
      // ref만 갱신하면 폴링 루프가 영영 차이를 못 본다 — 루프는 ref와 실제
      // Excalidraw 상태를 비교하는데, 우리가 방금 둘을 같게 만들어 놨기
      // 때문이다. 그러면 오버레이가 카메라를 따라가지 않는다(실측: 초기
      // 카메라를 180,150으로 옮겼는데 오버레이 transform은 translate(0,0)에
      // 멈춰 있었다). 그래서 여기서 직접 emit한다.
      //
      // setCamera는 부르지 않는다 — 스프링이 이 함수를 매 프레임 부르므로
      // 여기서 커밋하면 팬에서 없앤 프레임당 리렌더가 그대로 돌아온다.
      // 폴링 루프가 "멈췄다"를 보고 한 번 올려 준다.
      cameraRef.current = c;
      emitFrame(c);
    },
    [api, emitFrame],
  );

  /**
   * 화면 픽셀 단위로 화면을 민다 — 중클릭(휠 버튼) 팬.
   *
   * `screen = (world + scroll) * zoom`이므로 화면을 dx만큼 옮기려면
   * scroll을 `dx / zoom`만큼 더한다. 줌이 얼마든 **커서와 종이가 1:1로
   * 붙어 움직인다** — 사용자가 요구한 "마우스 감도와 동일한 속도"다.
   */
  const panByScreen = useCallback(
    (dx: number, dy: number) => {
      const c = cameraRef.current;
      applyCamera({
        scrollX: c.scrollX + dx / c.zoom,
        scrollY: c.scrollY + dy / c.zoom,
        zoom: c.zoom,
      });
    },
    [applyCamera],
  );

  const elementAtPoint = useCallback(
    (p: { x: number; y: number }, tolerance: number) => {
      if (!api) return false;
      const r: Rect = {
        x: p.x - tolerance,
        y: p.y - tolerance,
        w: tolerance * 2,
        h: tolerance * 2,
      };
      return api
        .getSceneElements()
        .some((e) => !e.isDeleted && elementHitsRect(e, r));
    },
    [api],
  );

  const hasElementSelection = useCallback(() => {
    const ids = api?.getAppState().selectedElementIds;
    return !!ids && Object.values(ids).some(Boolean);
  }, [api]);

  const clearElementSelection = useCallback(() => {
    api?.updateScene({ appState: { selectedElementIds: {} } });
  }, [api]);

  const toWorld = useCallback(
    (clientX: number, clientY: number, rootRect: DOMRect) => {
      const { scrollX, scrollY, zoom } = cameraRef.current;
      return {
        x: (clientX - rootRect.left) / zoom - scrollX,
        y: (clientY - rootRect.top) / zoom - scrollY,
      };
    },
    [],
  );

  // hand도 놓아 준다 — 글자 위에서 끌어도 화면이 움직여야 한다(isPassThroughTool 참조).
  const overlayInteractive = !isPassThroughTool(activeTool);

  return useMemo(
    () => ({
      api,
      setApi,
      camera,
      cameraRef,
      subscribeFrame,
      panByScreen,
      activeTool,
      setTool,
      setDrawStyle,
      overlayInteractive,
      getObstacles,
      selectElementsIn,
      elementAtPoint,
      hasElementSelection,
      clearElementSelection,
      applyCamera,
      toWorld,
    }),
    [
      api,
      camera,
      subscribeFrame,
      panByScreen,
      activeTool,
      setTool,
      setDrawStyle,
      overlayInteractive,
      getObstacles,
      selectElementsIn,
      elementAtPoint,
      hasElementSelection,
      clearElementSelection,
      applyCamera,
      toWorld,
    ],
  );
}

/**
 * 휠 버튼(중클릭)으로 어디서나 화면을 끈다.
 *
 * 사용자 요구: "그냥 마우스 휠 포인터를 클릭해서 움직이는 게 더 자연스럽다."
 * 손 도구를 고르러 가지 않아도 되고, 글·그림 **위에서도** 바로 된다.
 *
 * 두 가지를 반드시 막는다:
 *   1. `mousedown`의 기본 동작 — 윈도우에서 중클릭은 자동 스크롤(사방향 화살표
 *      커서)을 띄운다. 그게 뜨면 우리 팬과 겹쳐 화면이 제멋대로 흐른다.
 *   2. `auxclick` — 중클릭을 놓을 때 링크가 새 탭으로 열리는 경로.
 *
 * 리스너는 캡처 단계의 `window`에 건다. Excalidraw도 중클릭 팬을 갖고 있는데,
 * 둘이 같이 돌면 이동량이 두 배가 된다 — 우리가 먼저 받아 전파를 끊는다.
 */
export function useMiddleDragPan(
  ref: React.RefObject<HTMLElement | null>,
  panByScreen: (dx: number, dy: number) => void,
): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    let last: { x: number; y: number } | null = null;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      last = { x: e.clientX, y: e.clientY };
      document.body.style.cursor = "grabbing";
    };
    const onMove = (e: MouseEvent) => {
      if (!last) return;
      e.preventDefault();
      panByScreen(e.clientX - last.x, e.clientY - last.y);
      last = { x: e.clientX, y: e.clientY };
    };
    const stop = () => {
      if (!last) return;
      last = null;
      document.body.style.cursor = "";
    };
    const onAux = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };

    root.addEventListener("mousedown", onDown, { capture: true });
    window.addEventListener("mousemove", onMove, { capture: true });
    window.addEventListener("mouseup", stop, { capture: true });
    window.addEventListener("blur", stop);
    root.addEventListener("auxclick", onAux, { capture: true });
    return () => {
      root.removeEventListener("mousedown", onDown, { capture: true });
      window.removeEventListener("mousemove", onMove, { capture: true });
      window.removeEventListener("mouseup", stop, { capture: true });
      window.removeEventListener("blur", stop);
      root.removeEventListener("auxclick", onAux, { capture: true });
      stop();
    };
  }, [ref, panByScreen]);
}

/**
 * 카메라를 따라 DOM 속성 하나를 매 프레임 고친다.
 *
 * React를 거치지 않는 것이 요점이다 — 팬 중에 리렌더가 나면 아이템·미니맵·
 * 연결선이 전부 다시 돈다(그것이 "화면 이동이 답답하다"의 원인이었다).
 */
export function useCameraFrame(
  subscribeFrame: (cb: (c: Camera) => void) => () => void,
  ref: React.RefObject<HTMLElement | null>,
  apply: (el: HTMLElement, c: Camera) => void,
): void {
  // apply를 deps에 넣으면 인라인 화살표 함수가 매 렌더 새로 생겨 구독이
  // 매번 끊겼다 붙는다. ref로 최신 것만 들고 구독은 한 번만 건다.
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  }, [apply]);

  useEffect(() => {
    return subscribeFrame((c) => {
      const el = ref.current;
      if (el) applyRef.current(el, c);
    });
  }, [subscribeFrame, ref]);
}

/**
 * 오버레이 위에서 굴린 휠을 Excalidraw 캔버스로 재발행한다.
 *
 * **React의 `onWheel`을 쓰면 안 된다.** React는 wheel 리스너를 passive로 붙여서
 * `preventDefault()`가 무시되고 콘솔에 경고가 뜬다("Unable to preventDefault
 * inside passive event listener"). 막지 못하면 페이지가 같이 스크롤된다.
 *
 * 오버레이 컨테이너는 `pointer-events:none`이지만 **자식에서 버블링된 wheel은
 * 받는다** — 컨테이너 한 곳에만 붙이면 되고 아이템마다 붙일 필요가 없다.
 *
 * 실측(2026-07-30): ctrl+휠 → zoom 1.00→1.10, 일반 휠 → scrollY 0→−227.
 */
export function useWheelForwarding(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    const onWheel = (e: WheelEvent) => {
      /**
       * **우리 UI 위에서 굴린 휠은 넘기지 않는다.**
       *
       * 이 리스너는 오버레이 컨테이너 한 곳에 붙어 자식에서 버블링된 휠까지
       * 전부 받는다. 그래서 분류 드롭다운처럼 **스스로 스크롤되는 목록** 위에서
       * 굴려도 캔버스가 팬됐다 — 목록은 꼼짝 않고 화면만 움직인다(사용자 지적).
       *
       * `data-no-pan`은 "여기는 캔버스가 아니라 UI다"라는 표시이고, 포인터
       * 쪽에서 이미 같은 뜻으로 쓰고 있다. 휠도 같은 경계를 따른다 —
       * preventDefault를 하지 않으므로 브라우저가 평소대로 스크롤한다.
       */
      if ((e.target as HTMLElement | null)?.closest?.("[data-no-pan]")) return;

      const canvas = document.querySelector<HTMLCanvasElement>(
        ".excalidraw__canvas.interactive",
      );
      if (!canvas) return;
      e.preventDefault();
      e.stopPropagation();
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, enabled]);
}
