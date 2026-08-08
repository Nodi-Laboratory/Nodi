/**
 * 화면 위 크롬이 서로 안 겹치게 자리를 정한다 (사용자 지시 2026-08-08).
 *
 * 크롬을 140%로 키우자(`lib/ui/scale.ts`) 오른쪽 변이 좁아졌다. 도구바는
 * 세로로 길고 미니맵도 오른쪽에 붙으므로, 화면이 낮으면 둘이 겹친다. 입력창은
 * 아래 가운데라 우하단 미니맵과 겹친다.
 *
 * ## 두 단계로 푼다
 *
 *   1. **비켜서기** — 겹친 만큼만 도구바를 위아래로 민다(평소 방식).
 *   2. **나란히 서기** — 밀어도 화면 밖으로 나가면, 도구바를 지도와 같은
 *      높이대에 두고 **지도를 왼쪽으로** 물린다. 도구바가 바깥쪽 열을 갖는다.
 *
 * 1번으로 되는 상황에서 2번을 쓰면 평소 화면이 괜히 달라진다 — 그래서 **밀어서
 * 안 될 때만** 2번이다(사용자 지시: "일반 상황에서는 기존 방식을 유지").
 *
 * ## 여기는 순수 함수다
 *
 * 자리를 정하는 규칙이 DOM 조회와 섞이면 눈으로만 확인하게 된다. 값으로
 * 못 박아 두면 화면 없이도 경계를 지킬 수 있다.
 */

export type MapCorner = "tl" | "tr" | "bl" | "br";

export interface Box {
  w: number;
  h: number;
}

export interface ChromeInput {
  /** 캔버스 무대 크기. */
  stage: Box;
  /** 미니맵이 붙은 모서리. 닫혀 있으면 null. */
  corner: MapCorner | null;
  /** 미니맵 상자. */
  map: Box;
  /** 도구바 상자(세로로 길다). */
  rail: Box;
  /** 입력창 폭. */
  askW: number;
  /** 모서리 여백(미니맵과 같은 값). */
  margin: number;
  /** 크롬끼리 남길 틈. */
  gap: number;
}

export type RailMode =
  /** 화면 세로 가운데(평소). `shift`만큼 위아래로 비켜선다. */
  | "center"
  /** 지도와 나란히 — 위쪽 정렬. */
  | "top"
  /** 지도와 나란히 — 아래쪽 정렬. */
  | "bottom";

export interface ChromeFit {
  railMode: RailMode;
  /** `center`일 때 세로로 비켜설 양(px). 양수면 아래로. */
  railShift: number;
  /** 미니맵을 왼쪽으로 물릴 양(px, 0 이상). */
  mapDx: number;
  /** 입력창을 왼쪽으로 물릴 양(px, 0 이상). */
  askDx: number;
}

const NONE: ChromeFit = { railMode: "center", railShift: 0, mapDx: 0, askDx: 0 };

/** 두 구간이 겹치나. */
function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

export function fitChrome(input: ChromeInput): ChromeFit {
  const { stage, corner, map, rail, askW, margin, gap } = input;
  // 지도가 없거나 왼쪽에 있으면 도구바(오른쪽)와 만날 일이 없다.
  if (!corner || corner === "tl" || corner === "bl") return NONE;

  const mapTop = corner === "tr" ? margin : stage.h - margin - map.h;
  const mapBottom = mapTop + map.h;
  const railTop = (stage.h - rail.h) / 2;
  const railBottom = railTop + rail.h;

  if (!overlaps(railTop, railBottom, mapTop, mapBottom)) return NONE;

  // ── 1단계: 겹친 만큼만 민다 ────────────────────────────────────────
  const shift =
    corner === "tr" ? mapBottom + gap - railTop : -(railBottom + gap - mapTop);
  const movedTop = railTop + shift;
  const movedBottom = railBottom + shift;
  // 밀어서 화면 안에 다 들어오면 그것으로 끝이다(평소 방식).
  if (movedTop >= margin && movedBottom <= stage.h - margin) {
    return { railMode: "center", railShift: shift, mapDx: 0, askDx: 0 };
  }

  // ── 2단계: 나란히 서고 지도를 왼쪽으로 물린다 ─────────────────────
  //
  // 도구바가 **바깥쪽 열**을 갖는다(사용자 지시: "지도의 오른쪽에"). 지도는
  // 그만큼 왼쪽으로 물러난다.
  const mapDx = rail.w + gap;
  const railMode: RailMode = corner === "tr" ? "top" : "bottom";

  /**
   * 입력창은 아래 가운데다. 지도가 아래쪽으로 오면 겹칠 수 있다.
   *
   * 겹친 만큼만 왼쪽으로 민다 — 지도가 물러난 자리를 기준으로 잰다. 물러나기
   * 전 자리로 재면 필요 이상으로 밀린다.
   */
  let askDx = 0;
  if (corner === "br") {
    const mapLeft = stage.w - margin - map.w - mapDx;
    const askRight = (stage.w + askW) / 2;
    askDx = Math.max(0, askRight + gap - mapLeft);
  }
  return { railMode, railShift: 0, mapDx, askDx };
}
