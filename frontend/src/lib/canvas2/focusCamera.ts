/**
 * 새 답이 나왔을 때 카메라가 어디를 보는가 (D163).
 *
 * ## 왜 갈라야 했나
 *
 * D162는 "노드를 만들면 235%로 확 당겨서 읽히게"였다. 옳다 — 카드 하나만
 * 나올 때는. 그런데 235%에서 폭 560 카드는 **화면을 꽉 채운다**(1400px
 * 뷰포트 기준 보이는 world 폭이 약 596px). 카드 오른쪽에 남는 자리가 20px도
 * 안 되므로, 강의 클립을 옆에 아무리 잘 놓아도 학생 눈에는 아무것도 안 뜬
 * 것과 같다. 검색은 됐는데 화면에는 없는 상태다.
 *
 * 그래서 규칙을 둘로 나눈다:
 *
 *   딸린 것이 없다 → **D162 그대로**. 235%, 카드를 가로 가운데·위 1/3에.
 *   딸린 것이 있다 → 카드 + 딸린 것 **묶음이 다 들어오는 배율**로. 대신
 *                    아래로는 `minZoom`까지만 — 다 보여 주겠다고 글씨를
 *                    못 읽을 만큼 축소하면 그것대로 D162를 어긴다.
 *
 * 기하는 컴포넌트가 아니라 여기에 둔다. 이런 결함(화면 밖에 놓았다)은 눈보다
 * 테스트로 잡힌다 — 실제로 눈으로는 "추천이 안 뜬다"로만 보였다.
 */

import { union, type Rect } from "./rect";

export interface Camera {
  zoom: number;
  scrollX: number;
  scrollY: number;
}

export interface FocusOpts {
  /** 딸린 것이 없을 때 쓰는 배율 (D162: 2.35). */
  maxZoom: number;
  /** 묶음을 담느라 축소할 수 있는 하한. 글이 읽혀야 한다. */
  minZoom: number;
  /** 묶음 둘레에 남기는 화면 여백(px). */
  pad: number;
}

/**
 * 초점 카메라.
 *
 * @param target      새로 생긴 개념 카드
 * @param attached    그 카드에 딸린 것들(강의 클립·교과서 도판). 없으면 빈 배열.
 * @param vp          뷰포트 크기(px)
 */
export function focusCamera(
  target: Rect,
  attached: readonly Rect[],
  vp: { w: number; h: number },
  { maxZoom, minZoom, pad }: FocusOpts,
): Camera {
  // 딸린 것이 없다 — D162 그대로다. 여기를 건드리면 "노드가 크게 보인다"가
  // 조용히 깨진다.
  if (!attached.length) {
    const z = maxZoom;
    return {
      zoom: z,
      scrollX: vp.w / 2 / z - (target.x + target.w / 2),
      // 정중앙이 아니라 위 1/3 — 글이 아래로 자라기 때문이다(D162).
      scrollY: vp.h / 3 / z - target.y,
    };
  }

  const b = union([target, ...attached]) as Rect;   // 비지 않으므로 null이 아니다
  const fit = Math.min(
    maxZoom,
    (vp.w - pad * 2) / Math.max(b.w, 1),
    (vp.h - pad * 2) / Math.max(b.h, 1),
  );
  const zoom = Math.min(maxZoom, Math.max(minZoom, fit));

  /**
   * 들어가면 가운데, 넘치면 **왼쪽·위를 맞춘다.**
   *
   * 넘칠 때 가운데에 두면 양옆이 똑같이 잘리는데, 왼쪽에 있는 것은 개념
   * 카드(=답)다. 답의 첫 글자가 화면 밖에 있는 것보다는 제일 먼 첨부가
   * 잘리는 편이 낫다 — 글도 트리도 왼쪽·위에서부터 읽는다.
   */
  const fitsH = b.w * zoom <= vp.w - pad * 2;
  const fitsV = b.h * zoom <= vp.h - pad * 2;
  return {
    zoom,
    scrollX: fitsH ? vp.w / 2 / zoom - (b.x + b.w / 2) : pad / zoom - b.x,
    scrollY: fitsV ? (vp.h - b.h * zoom) / 2 / zoom - b.y : pad / zoom - b.y,
  };
}

/** 화면에 보이는 world 사각형. 테스트와 호출부가 같은 식을 쓴다. */
export function visibleWorld(cam: Camera, vp: { w: number; h: number }): Rect {
  return {
    x: -cam.scrollX,
    y: -cam.scrollY,
    w: vp.w / cam.zoom,
    h: vp.h / cam.zoom,
  };
}
