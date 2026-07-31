/**
 * 캔버스 v2 도메인 타입 (D122).
 *
 * v1과의 결정적 차이: **아이템은 DB에 행으로 존재한다.** v1의 개념 카드는
 * `nodes.answer` 텍스트 안의 줄 형식이었고 좌표도 없었다(D105) — 학생이
 * 옮기거나 고칠 자리가 아예 없었다.
 */

export type ItemKind = "concept" | "note" | "figure";
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
  /**
   * 이 답을 부른 질문 원문 — 하단 입력창으로 물었을 때만 있다.
   *
   * 질문을 **아이템으로 만들지 않는 대신** 여기 싣는다(사용자 지시 2026-07-31:
   * 평범한 질문마다 상자가 둘 생기면 캔버스가 어수선해진다). hover 툴팁이
   * 이걸 읽어 "무엇을 물어본 답인지"를 보여 준다.
   *
   * "AI에게 묻기"로 물었을 때는 비어 있다 — 그때는 부모 글이 곧 질문이다.
   */
  askedQuestion?: string;
  /** "AI에게 묻기" 버튼을 ×로 지웠나 (kind='note'). */
  askHidden?: boolean;
  /** "위치 정리" 버튼을 ×로 지웠나. 수정/태그변경 후에만 뜬다. */
  reflowDismissed?: boolean;
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
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "line"
  | "eraser"
  /** 우리 note 아이템을 만드는 도구 — Excalidraw text가 아니다. */
  | "note";

/** 그리기 도구 = 캔버스에 무언가를 그리는 도구. */
export const DRAW_TOOLS: readonly ToolName[] = [
  "freedraw",
  "rectangle",
  "ellipse",
  "arrow",
  "line",
  "eraser",
];

export function isDrawTool(t: ToolName): boolean {
  return DRAW_TOOLS.includes(t);
}

/**
 * 오버레이가 포인터 이벤트를 **놓아 줘야** 하는 도구.
 *
 * 그리기 도구 + `hand`다. hand를 빠뜨렸던 것이 "화면 이동이 답답하다"의
 * 원인이었다 — 글자 위에서 끌면 오버레이가 이벤트를 먹어 드래그가 아이템
 * 이동으로 가고, 화면은 꼼짝도 안 했다. 글이 많은 캔버스에서는 빈 곳을
 * 찾아야만 화면이 움직이는 셈이다.
 */
export function isPassThroughTool(t: ToolName): boolean {
  return t === "hand" || isDrawTool(t);
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
