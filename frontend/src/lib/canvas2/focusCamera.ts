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
 *   딸린 것이 없다 → 카드 하나가 **다 들어오는 선에서 가장 크게**(상한 235%),
 *                    가로 가운데·위 1/3에.
 *   딸린 것이 있다 → 카드 + 딸린 것 **묶음이 다 들어오는 배율**로. 대신
 *                    아래로는 `minZoom`까지만 — 다 보여 주겠다고 글씨를
 *                    못 읽을 만큼 축소하면 그것대로 D162를 어긴다.
 *
 * 기하는 컴포넌트가 아니라 여기에 둔다. 이런 결함(화면 밖에 놓았다)은 눈보다
 * 테스트로 잡힌다 — 실제로 눈으로는 "추천이 안 뜬다"로만 보였다.
 *
 * ## 235%는 상한이지 고정값이 아니다 (D166)
 *
 * D162는 배율을 **고정**했다. 딸린 것이 없으면 무조건 235%였는데, 폭 560
 * 카드는 235%에서 화면 위 **1316px**을 먹는다. 교실 노트북(1366×768)·구형
 * 크롬북(1024×768)에서는 화면보다 넓어서 **양쪽이 다 잘린다** — 실측
 * 2026-08-04, 1024폭에서 왼쪽 114px·오른쪽 178px이 화면 밖이었고 줄마다
 * 첫 글자가 왼쪽 레일 밑에 깔렸다. 학생 눈에는 "답이 안 뜬다"로 보인다.
 *
 * 그래서 235%를 **상한**으로 바꾼다. 넓은 화면에서는 그대로 235%이므로 D162의
 * "생기는 순간 읽을 수 있는 크기"는 지켜지고, 좁은 화면에서는 카드가 다
 * 들어오는 만큼만 당긴다. **잘린 큰 글씨보다 온전한 작은 글씨가 읽힌다.**
 *
 * ## 화면 크기가 아니라 **쓸 수 있는 자리**로 잰다 (D166)
 *
 * 캔버스 위에는 UI가 늘 떠 있다 — 왼쪽 레일·오른쪽 도구 레일·아래 질문창.
 * 뷰포트 전체로 계산하면 딱 맞췄다고 생각한 카드가 그 밑에 깔린다(D163이
 * 딸린 것 있는 쪽에서만 빼고 있었는데, 잘리는 건 양쪽 다 마찬가지였다).
 * 그래서 `vp`가 **여백(inset)까지 받아** 두 갈래가 같은 자리를 본다.
 */

import { union, type Rect } from "./rect";

export interface Camera {
  zoom: number;
  scrollX: number;
  scrollY: number;
}

export interface FocusOpts {
  /** 배율 **상한** (D162의 2.35). 넓은 화면에서는 이 값이 그대로 쓰인다. */
  maxZoom: number;
  /** 묶음을 담느라 축소할 수 있는 하한. 글이 읽혀야 한다. */
  minZoom: number;
  /** 묶음 둘레에 남기는 화면 여백(px). */
  pad: number;
}

/**
 * 뷰포트 + 그 위에 늘 떠 있는 UI가 먹는 자리(px).
 *
 * 캔버스 스테이지는 창 전체를 덮고 UI가 그 위에 겹쳐 뜬다. 그래서 "쓸 수 있는
 * 자리"는 창보다 작다 — 안 빼면 초점이 레일 밑으로 들어간다(D166).
 */
export interface FocusViewport {
  w: number;
  h: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/** UI를 뺀, 실제로 글을 놓을 수 있는 화면 사각형. */
function usable(vp: FocusViewport): Rect {
  const left = vp.left ?? 0;
  const top = vp.top ?? 0;
  return {
    x: left,
    y: top,
    // 여백이 화면보다 크게 잡히는 극단(아주 작은 창)에서도 0으로 죽지 않게 한다.
    w: Math.max(1, vp.w - left - (vp.right ?? 0)),
    h: Math.max(1, vp.h - top - (vp.bottom ?? 0)),
  };
}

/**
 * 초점 카메라.
 *
 * @param target      새로 생긴 개념 카드
 * @param attached    그 카드에 딸린 것들(강의 클립·교과서 도판). 없으면 빈 배열.
 * @param vp          뷰포트 크기와 UI 여백(px)
 */
export function focusCamera(
  target: Rect,
  attached: readonly Rect[],
  vp: FocusViewport,
  { maxZoom, minZoom, pad }: FocusOpts,
): Camera {
  const box = usable(vp);

  /**
   * 딸린 것이 없다 — 카드 하나만 보면 된다 (D162 → D166).
   *
   * 배율은 **상한 안에서 카드가 다 들어오는 값**이다. 넓은 화면에서는 상한에
   * 걸려 235% 그대로이고, 좁은 화면에서는 잘리지 않을 만큼만 당긴다.
   * 세로는 재지 않는다 — 글은 아래로 자라므로 높이를 맞추려 들면 긴 답일수록
   * 축소되어 D162가 뒤집힌다. 위 1/3에 두는 것이 그 자리의 답이다.
   */
  if (!attached.length) {
    const fit = (box.w - pad * 2) / Math.max(target.w, 1);
    const z = Math.min(maxZoom, Math.max(minZoom, fit));
    return {
      zoom: z,
      scrollX: (box.x + box.w / 2) / z - (target.x + target.w / 2),
      // 정중앙이 아니라 위 1/3 — 글이 아래로 자라기 때문이다(D162).
      scrollY: (box.y + box.h / 3) / z - target.y,
    };
  }

  const b = union([target, ...attached]) as Rect;   // 비지 않으므로 null이 아니다
  const fit = Math.min(
    maxZoom,
    (box.w - pad * 2) / Math.max(b.w, 1),
    (box.h - pad * 2) / Math.max(b.h, 1),
  );
  const zoom = Math.min(maxZoom, Math.max(minZoom, fit));

  /**
   * 들어가면 가운데, 넘치면 **왼쪽·위를 맞춘다.**
   *
   * 넘칠 때 가운데에 두면 양옆이 똑같이 잘리는데, 왼쪽에 있는 것은 개념
   * 카드(=답)다. 답의 첫 글자가 화면 밖에 있는 것보다는 제일 먼 첨부가
   * 잘리는 편이 낫다 — 글도 트리도 왼쪽·위에서부터 읽는다.
   *
   * 넘칠 때는 `pad`를 **쓰지 않는다** (D166). 여백은 들어갈 때 숨 쉴 자리로
   * 두는 것이지, 이미 넘치는 묶음에서 왼쪽에 72px을 비우면 그만큼이 그대로
   * 오른쪽 밖으로 밀린다 — 실측 2026-08-04: 배율이 하한(1.15)에 걸린 1280
   * 화면에서 클립 카드의 오른쪽이 딱 그 폭만큼 잘렸다.
   */
  const fitsH = b.w * zoom <= box.w - pad * 2;
  const fitsV = b.h * zoom <= box.h - pad * 2;
  return {
    zoom,
    scrollX: fitsH ? (box.x + box.w / 2) / zoom - (b.x + b.w / 2) : box.x / zoom - b.x,
    scrollY: fitsV
      ? (box.y + (box.h - b.h * zoom) / 2) / zoom - b.y
      : box.y / zoom - b.y,
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

/* ────────────────────── 자라는 카드에서 물러나기 (D210 2-2) ────────────── */

export interface BackOffOpts {
  /** 더 낮출 수 있는 하한. 여기 닿으면 그만 줄이고 위쪽을 붙인다. */
  minZoom: number;
  /**
   * 카드 아래에 남길 화면 비율(0.15~0.20).
   *
   * 꽉 맞추면 다 보여도 답답하고, **다음 문단이 이어질 자리가 없어 보인다** —
   * 스트리밍 중에는 실제로 곧 이어지므로 그 자리가 있어야 한다.
   */
  headroom: number;
  /** 카드 위에 남길 화면 여백(px). */
  topPad: number;
}

/**
 * **자라는 카드가 화면 아래로 넘치면** 그만큼 물러난 카메라 (D210 2-2).
 *
 * ## 이것은 "세로는 재지 않는다"를 뒤집는 것이 아니다
 *
 * 위 `focusCamera`에는 그 결정이 근거와 함께 적혀 있다 — 높이까지 맞추려
 * 들면 **긴 답일수록 축소되어** 처음부터 크게 보여 주려던 이유(D162)가
 * 뒤집힌다는 것이다. 그 판단은 지금도 옳다.
 *
 * 바뀐 것은 **시점**이다. 처음에는 여전히 높이를 안 본다(235%로 당긴다).
 * 그 뒤 스트리밍으로 글이 자라 **실제로 화면을 넘길 때만** 물러난다.
 * "긴 답이 예상되니 미리 줄인다"와 "지금 잘리고 있으니 줄인다"는 다르다 —
 * 앞의 것은 짧은 답까지 작게 만들고, 뒤의 것은 잘릴 때만 값을 치른다.
 *
 * ## 넘치지 않으면 아무 일도 하지 않는다
 *
 * `null`을 돌려준다. 매 프레임 배율을 다시 계산해 밀어 넣으면 카메라가
 * 끊임없이 흔들린다 — 넘침이 감지된 순간에만 목표를 새로 정하고, 그리로
 * 가는 일은 스프링에게 맡긴다.
 */
export function backOffCamera(
  card: Rect,
  cam: Camera,
  vp: FocusViewport,
  { minZoom, headroom, topPad }: BackOffOpts,
): Camera | null {
  const box = usable(vp);
  // 카드 아래 끝이 쓸 수 있는 자리를 넘었나 (화면 px).
  const topOnScreen = (card.y + cam.scrollY) * cam.zoom;
  const bottomOnScreen = topOnScreen + card.h * cam.zoom;
  if (bottomOnScreen <= box.y + box.h) return null;

  /**
   * 목표 배율 — "딱 들어가는 배율"에서 한 단계 더 물러난 값이다.
   *
   * 남길 자리(headroom)를 뺀 높이에 맞춘다. **절대 더 키우지 않는다**:
   * 넘쳤다는 것은 지금 배율이 크다는 뜻이므로 목표는 언제나 지금 이하다.
   */
  const want = (box.h * (1 - headroom)) / Math.max(1, card.h);
  const zoom = Math.min(cam.zoom, Math.max(minZoom, want));

  /**
   * 카드 **위쪽**을 화면에 붙인다.
   *
   * 하한에 닿아 다 담지 못할 때 어느 쪽을 자를지의 문제다. 읽기는 위에서
   * 시작하므로 잘리는 쪽은 아래여야 한다 — 위가 잘리면 첫 문장을 못 읽는다.
   */
  return {
    zoom,
    scrollX: (box.x + box.w / 2) / zoom - (card.x + card.w / 2),
    scrollY: (box.y + topPad) / zoom - card.y,
  };
}
