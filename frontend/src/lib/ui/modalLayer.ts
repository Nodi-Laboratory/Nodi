/**
 * **팝업이 떠 있으면 뒤쪽 화면은 키를 안 먹는다** (2026-08-10).
 *
 * 캔버스는 document에 **캡처**로 키를 듣는다 — 방향키(카드 사이 이동)와 도구
 * 단축키가 그렇다. 둘 다 `stopPropagation`까지 하므로, 나중에 뜬 팝업이 같은
 * 키를 들으려 해도 **그 이벤트는 오지 않는다**(실측 2026-08-10: 도움말에서
 * 좌우 화살표가 한 번도 안 먹었다. 팝업 쪽 코드는 멀쩡했고, 문제는 순서였다).
 *
 * 팝업마다 "캔버스보다 먼저 듣는 법"을 각자 알아내게 두면 다음 팝업에서 또
 * 틀린다. 대신 **여기 한 곳**에 "지금 팝업이 떠 있나"를 두고, 키를 가로채는
 * 쪽이 그것을 먼저 본다.
 *
 * 세는 방식인 이유: 팝업 위에 팝업이 뜰 수 있다(설정 위의 확인창). 하나가
 * 닫혔다고 빗장을 풀면 남은 팝업이 키를 빼앗긴다.
 */

let depth = 0;

/** 팝업이 열렸다고 알린다. 반환값은 닫을 때 부를 함수다. */
export function pushModal(): () => void {
  depth += 1;
  sync();
  let released = false;
  return () => {
    // 두 번 불려도 한 번만 센다 — StrictMode의 이중 정리에서 실제로 일어난다.
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    sync();
  };
}

/** 지금 팝업이 떠 있나 — 키를 가로채는 쪽이 이걸 먼저 본다. */
export function isModalOpen(): boolean {
  return depth > 0;
}

/**
 * 화면에도 남긴다 — e2e가 "팝업이 떠 있다"를 DOM으로 확인할 수 있어야 하고,
 * 나중에 CSS로 뒤쪽을 흐리게 하고 싶을 때도 이 표시를 쓴다.
 */
function sync() {
  if (typeof document === "undefined") return;
  if (depth > 0) document.body.dataset.modalOpen = "1";
  else delete document.body.dataset.modalOpen;
}
