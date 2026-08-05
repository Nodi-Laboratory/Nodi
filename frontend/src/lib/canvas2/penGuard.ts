"use client";

/**
 * 펜을 쓰는 동안 **손이 UI를 건드리지 못하게** 한다 (D176, 사용자 지시 2026-08-04).
 *
 * 태블릿에서 펜을 쥐면 손날·손가락이 화면에 먼저 닿는다. 입력판은 그 입력을
 * 버리는데(획 하나가 통째로 낙서가 되므로), **화면 위에 떠 있는 버튼들은 안
 * 버렸다** — 사용자 보고 2026-08-04: "펜으로 쓰니까 오른쪽의 도구 바가 계속
 * 선택된다". 쓰는 동안 도구가 지우개로 바뀌면 다음 동작이 엉뚱해진다.
 *
 * ## 왜 "펜을 본 적 있음"이 아니라 시간 창인가
 *
 * 입력판의 **잉크**는 "펜을 한 번이라도 봤으면 손가락은 안 그린다"는 더 센
 * 규칙을 쓴다(손바닥은 쓰는 내내 닿아 있고, 그 접촉이 곧 낙서다). 버튼에
 * 같은 규칙을 주면 **펜을 한 번 쓴 뒤로는 손가락으로 아무 버튼도 못 누른다** —
 * 눌러도 아무 일이 안 일어나는, 화면에 드러나지 않는 고장이 된다.
 *
 * 손이 버튼을 건드리는 건 **펜이 움직이는 그 순간**이므로 시간 창이면 족하다.
 * 펜을 내려놓고 잠시 뒤 손가락으로 누르는 것은 의도한 조작이라 통과시킨다.
 *
 * ## 왜 click을 삼키나
 *
 * touch의 pointerdown을 preventDefault로 막아 후속 click을 없애는 방법은
 * 브라우저마다 갈린다. 그래서 click을 **캡처 단계에서 직접** 끊는다. 키보드
 * (Enter)는 pointerdown이 없어 직전 종류가 갱신되지 않으므로, 손가락으로
 * 만졌던 흔적이 키보드 조작을 막는 일은 없다 — 펜을 쓰는 중이 아니면 어차피
 * 아무것도 안 막는다.
 */

import { useEffect } from "react";

/**
 * 펜을 마지막으로 본 뒤 이만큼(ms)은 터치를 손날로 본다.
 *
 * 획 하나를 긋는 사이 pointermove가 계속 들어오므로 쓰는 내내 갱신된다.
 * 짧으면 획과 획 사이(글자를 옮겨 쓰는 순간)에 창이 닫히고, 길면 펜을 내려놓고
 * 손가락으로 누르는 것까지 먹는다.
 */
export const PEN_WINDOW_MS = 900;

let lastPenAt = Number.NEGATIVE_INFINITY;

/**
 * 마지막 pointerdown의 종류.
 *
 * click 이벤트에는 `pointerType`이 없다 — 손가락이 만든 click인지 알려면
 * 직전 pointerdown을 기억하는 수밖에 없다(터치는 pointerdown → click 순서).
 */
let lastDownType = "";

/** 펜을 봤다. `at`은 `performance.now()` 기준. */
export function notePen(at: number): void {
  lastPenAt = at;
}

/** 지금 펜을 쓰는 중인가(= 터치를 손날로 볼 시간인가). */
export function penActive(now: number): boolean {
  return now - lastPenAt < PEN_WINDOW_MS;
}

/** 테스트·세션 경계용. */
export function resetPenWatch(): void {
  lastPenAt = Number.NEGATIVE_INFINITY;
  lastDownType = "";
}

/*
 * 선택 금지·탭 하이라이트 제거·`touch-action`은 **CSS에 있다**(globals.css의
 * `.canvas2`). 인라인 스타일로 컴포넌트마다 붙이다가 옮겼다 — 상속되는 속성을
 * 스무 곳에 복사하면 빠뜨린 한 곳을 손날이 찾아낸다.
 */

/**
 * 펜 활동 감시자. 창 전체에서 **캡처 단계로** 듣는다 — 펜이 어디를 지나가든
 * (입력판이든 캔버스든 허공이든) 그 사실을 알아야 한다.
 *
 * 참조 카운트로 한 번만 붙인다. `pointermove`는 초당 수백 번 오지만 하는 일이
 * 문자열 비교 하나라 무시할 수 있다.
 */
let watchers = 0;
let detach: (() => void) | null = null;

function onPointer(e: PointerEvent): void {
  // hover도 센다 — 손이 먼저 닿기 전에 펜이 화면 근처에 오는 것이 보통이다.
  if (e.pointerType === "pen") notePen(performance.now());
  if (e.type === "pointerdown") lastDownType = e.pointerType;
}

function watchPen(): () => void {
  if (watchers++ === 0) {
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", onPointer, opts);
    window.addEventListener("pointermove", onPointer, opts);
    detach = () => {
      window.removeEventListener("pointerdown", onPointer, opts);
      window.removeEventListener("pointermove", onPointer, opts);
    };
  }
  return () => {
    if (--watchers === 0) {
      detach?.();
      detach = null;
    }
  };
}

/**
 * 손날이 만든 click을 **캔버스 화면 전체에서** 삼킨다.
 *
 * 버튼마다 빗장을 다는 방식으로 시작했는데(입력판·도구 레일), 사용자 지시로
 * "손글씨 주변 컴포넌트 전부"가 되면서 **한 곳에서 판정하게** 바꿨다. 버튼이
 * 스무 개면 열아홉 개만 고치는 일이 반드시 생기고, 빠진 하나는 손날이 찾아낸다.
 *
 * document의 **캡처 단계**에서 듣는다 — React는 루트 컨테이너에 리스너를
 * 붙이므로 여기서 끊으면 어떤 onClick도 돌지 않는다.
 *
 * **`.canvas2` 안으로 좁히지 않는다**(사용자 보고 2026-08-04: "왼쪽의
 * 메뉴바에 클릭이 되어 문제가 발생했다"). 왼쪽 아이콘 레일은 `<main>` 밖의
 * 형제라 그 범위 밖이었고, 손이 닿으면 쓰던 도중에 **다른 화면으로 넘어간다.**
 * 대신 이 감시자는 캔버스 화면에서만 설치된다(`useCanvasTouchGuard`) —
 * 로그인·관리자 화면에는 애초에 붙지 않으므로 좁힐 필요가 없다.
 */
function guardClicks(): () => void {
  const onClick = (e: MouseEvent) => {
    if (lastDownType !== "touch") return; // 펜·마우스·키보드는 언제나 통과
    if (!penActive(performance.now())) return; // 펜을 안 쓰는 중이면 손가락이 주인이다
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener("click", onClick, { capture: true });
  return () => document.removeEventListener("click", onClick, { capture: true });
}

/**
 * 캔버스 화면에 **한 번** 건다(`CanvasWorkspace`).
 *
 * 펜 활동 감시 + 손날 click 차단이 한 묶음이다 — 하나만 걸면 아무 일도 안
 * 하거나(감시만), 영영 막힌다(차단만).
 */
export function useCanvasTouchGuard(): void {
  useEffect(() => {
    const stopWatch = watchPen();
    const stopGuard = guardClicks();
    return () => {
      stopWatch();
      stopGuard();
    };
  }, []);
}
