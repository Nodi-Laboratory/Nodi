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
  /**
   * 위쪽에 떠 있는 상단 바의 높이 (2026-08-10).
   *
   * 바가 캔버스 위로 올라오면서(사용자 지시) 위 모서리의 지도가 그만큼 내려
   * 앉는다(`cornerSnap.cornerPos`). 여기서 같은 값을 안 보면 **계산이 보는
   * 지도 자리와 화면의 지도 자리가 갈린다** — 겹치는데 안 겹친다고 하거나
   * 그 반대가 된다.
   */
  topInset?: number;
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
  /**
   * 입력창이 쓸 수 있는 최대 폭(화면 px). `null`이면 제한 없음.
   *
   * **미는 것만으로는 못 푸는 경우가 있다** (2026-08-09). 우하단에 지도가 오면
   * 아래 변에 셋이 선다 — 입력창 · 지도 · 도구바. 140%에서 그 합이 쓸 수 있는
   * 폭을 넘으면(실측 1440×900: 952+381+64+틈 = 1425 > 1350) 겹침을 없애려고
   * 미는 양이 화면 밖을 가리킨다.
   *
   * 실측 2026-08-09: 입력창 왼쪽 변이 **−117px**이었다. 첨부 버튼과 안내
   * 문구가 통째로 화면 밖이라 학생이 파일을 붙일 수가 없었다. 겹치는 것보다
   * 나쁘다 — 겹치면 가려지기라도 하지, 이건 아예 없다.
   *
   * 그래서 셋 중 **늘었다 줄었다 하는 것**(입력창은 `min(680px, …)`)이 자리를
   * 양보한다. 지도와 도구바는 정해진 크기다.
   */
  askMaxW: number | null;
}

const NONE: ChromeFit = {
  railMode: "center",
  railShift: 0,
  mapDx: 0,
  askDx: 0,
  askMaxW: null,
};

/** 두 구간이 겹치나. */
function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

export function fitChrome(input: ChromeInput): ChromeFit {
  const { stage, corner, map, rail, askW, margin, gap, topInset = 0 } = input;
  if (!corner) return NONE;

  const top = corner === "tl" || corner === "tr";
  const mapTop = top ? margin + topInset : stage.h - margin - map.h;
  const mapBottom = mapTop + map.h;
  /** 지도의 가로 자리. 왼쪽 모서리면 왼쪽 변에, 오른쪽이면 오른쪽 변에 붙는다. */
  const mapLeft =
    corner === "tl" || corner === "bl" ? margin : stage.w - margin - map.w;
  const mapRight = mapLeft + map.w;

  // 도구바는 오른쪽 변에 붙어 있다.
  const railRight = stage.w - margin;
  const railLeft = railRight - rail.w;
  const railTop = (stage.h - rail.h) / 2;
  const railBottom = railTop + rail.h;

  /**
   * ⚠️ **모서리로 단정하지 않는다** (사용자 보고 2026-08-10: "미니맵이랑 도구
   * 바가 겹친다").
   *
   * 예전에는 "지도가 왼쪽이면 오른쪽 도구바와 만날 일이 없다"고 곧장 끝냈다.
   * 그런데 지도는 **넓다** — 왼쪽에 붙어도 오른쪽 변까지 닿으면 도구바가 그
   * 아래 깔린다. 가로도 세로처럼 **재서** 판단한다.
   */
  if (!overlaps(railLeft, railRight, mapLeft, mapRight)) return NONE;
  if (!overlaps(railTop, railBottom, mapTop, mapBottom)) return NONE;


  // ── 1단계: 겹친 만큼만 민다 ────────────────────────────────────────
  //
  // 지도가 위쪽이면 도구바를 아래로, 아래쪽이면 위로 비킨다.
  const shift = top ? mapBottom + gap - railTop : -(railBottom + gap - mapTop);
  const movedTop = railTop + shift;
  const movedBottom = railBottom + shift;
  // 밀어서 화면 안에 다 들어오면 그것으로 끝이다(평소 방식).
  if (movedTop >= margin && movedBottom <= stage.h - margin) {
    return { railMode: "center", railShift: shift, mapDx: 0, askDx: 0, askMaxW: null };
  }

  /**
   * 왼쪽에 붙은 지도는 **왼쪽으로 더 물릴 곳이 없다.**
   *
   * 2단계는 "도구바가 바깥쪽 열을 갖고 지도가 왼쪽으로 물러난다"인데, 지도가
   * 이미 왼쪽 변에 붙어 있으면 물러날 자리가 없다. 밀 수 있는 만큼만 밀고
   * 끝낸다 — 그래도 안 되면 그건 지도가 화면을 거의 다 덮은 것이라, 자리를
   * 다투는 것보다 학생이 지도를 접는 편이 빠르다.
   */
  if (corner === "tl" || corner === "bl") {
    const 한계 = top
      ? Math.min(shift, stage.h - margin - railBottom)
      : Math.max(shift, margin - railTop);
    return { railMode: "center", railShift: 한계, mapDx: 0, askDx: 0, askMaxW: null };
  }

  // ── 2단계: 나란히 서고 지도를 왼쪽으로 물린다 ─────────────────────
  //
  // 도구바가 **바깥쪽 열**을 갖는다(사용자 지시: "지도의 오른쪽에"). 지도는
  // 그만큼 왼쪽으로 물러난다.
  const mapDx = rail.w + gap;
  const railMode: RailMode = top ? "top" : "bottom";

  /**
   * 입력창은 아래 가운데다. 지도가 아래쪽으로 오면 겹칠 수 있다.
   *
   * **지도 왼쪽에 남는 자리를 하나의 방으로 보고, 그 안에 입력창을 앉힌다.**
   * 처음에는 "겹친 만큼만 왼쪽으로 민다"였는데, 그 규칙에는 상한이 없어서
   * 남는 자리보다 입력창이 넓으면 **화면 밖을 가리켰다**(실측: 왼쪽 변 −117px,
   * 첨부 버튼이 사라졌다). 방을 먼저 정하고 그 안에서 가운데를 잡으면 미는
   * 양과 줄이는 양이 **같은 계산에서** 나온다.
   */
  let askDx = 0;
  let askMaxW: number | null = null;
  if (corner === "br" && askW > 0) {
    const mapLeft = stage.w - margin - map.w - mapDx;
    // 입력창이 쓸 수 있는 방: 왼쪽 여백 ~ 지도 왼쪽 변에서 한 틈 앞.
    const room = Math.max(0, mapLeft - gap - margin);
    // 방보다 넓을 때만 줄인다. **넉넉하면 아무것도 안 한다** — 넓은 화면에서
    // 괜히 좁아지면 평소 화면이 달라진다(사용자 지시: "일반 상황에서는 기존
    // 방식을 유지").
    const w = Math.min(askW, room);
    if (w < askW) askMaxW = w;
    const 왼쪽 = (stage.w - w) / 2;
    const 넘침 = 왼쪽 + w - (mapLeft - gap);
    // 겹친 만큼만 민다. 단 **왼쪽 여백을 넘어가지 않는다** — 그 상한이 없어서
    // 입력창이 화면 밖으로 나갔다.
    askDx = Math.max(0, Math.min(넘침, 왼쪽 - margin));
  }
  return { railMode, railShift: 0, mapDx, askDx, askMaxW };
}
