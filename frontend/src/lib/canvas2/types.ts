/**
 * 캔버스 v2 도메인 타입 (D122).
 *
 * v1과의 결정적 차이: **아이템은 DB에 행으로 존재한다.** v1의 개념 카드는
 * `nodes.answer` 텍스트 안의 줄 형식이었고 좌표도 없었다(D105) — 학생이
 * 옮기거나 고칠 자리가 아예 없었다.
 */

export type ItemKind = "concept" | "note" | "figure" | "clip";
export type ItemSource = "ai" | "user";

/** 아이템 부가 정보. 스키마를 늘리기 애매한 렌더 힌트만 담는다. */
export interface ItemData {
  /** 교과서 도판(kind='figure') 메타. url은 signed라 만료된다 — 영속 금지(D87). */
  figure?: {
    figureId: string;
    fileId: string;
    page: number;
    caption: string;
    url: string;
    score?: number;
  };
  /** 강의 클립(kind='clip') 메타. page_url은 안정적(EBS 공식 링크) — 영속한다. */
  clip?: {
    clipId: string;
    videoId?: string;
    title: string;
    startSec: number;
    timelineLabel: string;
    pageUrl: string;
    videoTitle?: string;
    score?: number;
  };
  /**
   * 이 답을 부른 질문 원문 — 하단 입력창으로 물었을 때만 있다.
   *
   * 질문을 **아이템으로 만들지 않는 대신** 여기 싣는다(사용자 지시 2026-07-31:
   * 평범한 질문마다 상자가 둘 생기면 캔버스가 어수선해진다). hover 툴팁이
   * 이걸 읽어 "무엇을 물어본 답인지"를 보여 준다.
   *
   * 하단 입력창이든 "다시 질문하기"든 **언제나** 싣는다(D149). 옛 행 중
   * "AI에게 묻기"로 만든 것만 비어 있다 — 그때는 부모 글이 곧 질문이었다.
   */
  askedQuestion?: string;
  /** "위치 정리" 버튼을 ×로 지웠나. 수정/태그변경 후에만 뜬다. */
  reflowDismissed?: boolean;
  /**
   * 손잡이로 정한 도판 상자 크기 (D142 → D147: 도판 전용).
   *
   * 글 상자는 크기를 조절하지 않는다(사용자 지시 2026-08-02) — 이 필드는
   * 이제 교과서 도판(kind='figure')만 쓴다. 스키마에 열을 더하지 않고 여기
   * 두는 이유는 좌표와 달리 **배치 엔진의 입력이 아니라 렌더 힌트**이기
   * 때문이다. 폭·높이는 ResizeObserver 실측으로 배치에 들어가므로, 화면이
   * 이 값을 반영하면 배치는 자동으로 따라온다. 도판은 비율 고정이라 `w`/`h`가
   * 이미지 자연 비율을 지킨다.
   */
  size?: { w: number; h: number };
}

export interface CanvasItem {
  id: string;
  sessionId: string;
  /** 어느 턴에서 나왔나. 사용자 메모는 null. */
  nodeId: string | null;
  /** AI 응답이 어느 메모에 대한 답인가 (연결선 D126). */
  parentItemId: string | null;

  kind: ItemKind;
  source: ItemSource;

  title: string | null;
  /** 원문(마크업 포함). 파싱은 렌더 시점에 한다. */
  body: string;
  tag: string | null;

  /** world 좌표. top-left 기준. */
  x: number;
  y: number;
  /**
   * 학생이 드래그로 자리를 정했나.
   *
   * false → 배치 엔진이 자리를 정한다(결정론)
   * true  → 엔진은 장애물로만 읽고 절대 옮기지 않는다
   */
  pinned: boolean;

  /** 같은 태그 열 안에서의 순서. 생성 순서 보존. */
  seq: number;
  data: ItemData;

  // --- 클라이언트 전용(서버로 보내지 않는다) ---
  /** ResizeObserver 실측 높이. 배치의 **입력**이다. */
  _height?: number;
  /** 스트리밍 중이라 아직 저장되지 않았다. */
  _pending?: boolean;
  /** 수정/태그변경 직후 — "위치 정리" 버튼을 띄울 상태. */
  _needsReflow?: boolean;
  /** 구 세션에서 파싱만 해 온 아이템(아직 DB에 없다). 첫 편집 때 승격한다. */
  _legacy?: boolean;
}

/** Excalidraw와 공유하는 카메라. screen = (world + scroll) * zoom */
export interface Camera {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 우측 도구 레일의 도구. Excalidraw ToolType과 이름을 맞춘다. */
export type ToolName =
  | "selection"
  | "hand"
  | "freedraw"
  /**
   * 형광펜 (D150). **Excalidraw에는 없는 도구다** — 자유선에 반투명·굵은
   * 획 스타일을 물려 만든다. 그래서 Excalidraw의 appState는 이걸
   * `freedraw`로 보고하고, 우리가 따로 기억해야 한다(note와 같은 처지).
   */
  | "highlighter"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "line"
  | "eraser"
  /** 우리 note 아이템을 만드는 도구 — Excalidraw text가 아니다. */
  | "note"
  /**
   * 질문하는 펜 (D176) — 캔버스에 손으로 질문을 쓴다.
   *
   * note와 같은 처지다: Excalidraw에는 선택 도구를 물려 두고 우리 레이어가
   * 포인터를 가져간다. 그린 획은 **씬에 저장되지 않는다** — 글자가 되는
   * 순간 사라지는 입력 수단이다.
   */
  | "askpen"
  /**
   * 카드 수정 도구 (D180) — **관계를 손으로 다시 엮는다.**
   *
   * 별 포인터로 자식 카드를 끌면 연결이 끊기고, 다른 카드에 가져다 대면
   * 붙는다. 전용 도구인 이유는 기본 드래그로 같은 일을 하면 **카드를
   * 옮기려다 관계가 끊기기** 때문이다(사용자 지시 2026-08-05).
   *
   * `note`·`askpen`과 같은 처지다: Excalidraw에는 선택 도구를 물려 두고
   * 우리 오버레이가 포인터를 가져간다. `isPassThroughTool`에는 **넣지
   * 않는다** — 아이템이 포인터를 받아야 끌 수 있다.
   */
  | "cardedit";

/** 그리기 도구 = 캔버스에 무언가를 그리는 도구. */
export const DRAW_TOOLS: readonly ToolName[] = [
  "freedraw",
  "highlighter",
  "rectangle",
  "ellipse",
  "arrow",
  "line",
  "eraser",
];

export function isDrawTool(t: ToolName): boolean {
  return DRAW_TOOLS.includes(t);
}

/** 색을 고를 수 있는 도구. 지우개만 빠진다 — 지우는 데 색이 없다. */
export function isColorableTool(t: ToolName): boolean {
  return isDrawTool(t) && t !== "eraser";
}

/**
 * 그리기 스타일 — Excalidraw `currentItem*` appState로 나간다 (D150).
 *
 * 값의 의미는 Excalidraw 규약을 그대로 따른다:
 *   strokeWidth  자유선은 이 값 × 4.25 px로 그려진다(dist 실측)
 *   opacity      0~100
 *   roughness    0=매끈, 1=artist(기본값)
 */
export interface DrawStyle {
  strokeColor: string;
  opacity: number;
  strokeWidth: number;
  roughness: number;
}

/**
 * 오버레이가 포인터 이벤트를 **놓아 줘야** 하는 도구.
 *
 * 그리기 도구 + `hand` + **질문하는 펜**이다.
 *
 * hand를 빠뜨렸던 것이 "화면 이동이 답답하다"의 원인이었다 — 글자 위에서
 * 끌면 오버레이가 이벤트를 먹어 드래그가 아이템 이동으로 가고, 화면은
 * 꼼짝도 안 했다. 글이 많은 캔버스에서는 빈 곳을 찾아야만 화면이 움직이는
 * 셈이다.
 *
 * 질문하는 펜(D176)도 같은 처지다. 빠뜨렸을 때 **글 위에서 시작한 획이 통째로
 * 사라졌다**(실측 2026-08-04: 세 획을 그었는데 둘만 남았다). 학생 눈에는
 * "가끔 안 써진다"로 보이고, 글이 많은 캔버스일수록 자주 난다.
 * `DRAW_TOOLS`에는 넣지 않는다 — 거기 넣으면 색 팔레트가 딸려 오는데,
 * 질문 필기는 언제나 먹이다(OCR로 갈 그림이라 색이 의미가 없다).
 */
export function isPassThroughTool(t: ToolName): boolean {
  return t === "hand" || t === "askpen" || isDrawTool(t);
}

// --- 렌더용 블록 (markup.ts가 만든다) ----------------------------------------

export interface MarkToken {
  ch: string;
  /** **굵게** */
  b?: boolean;
  /** ==형광펜== */
  h?: boolean;
}

export interface RenderBlock {
  type: "p" | "li";
  tokens: MarkToken[];
}
