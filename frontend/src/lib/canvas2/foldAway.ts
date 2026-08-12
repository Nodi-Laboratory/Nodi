/**
 * 딸린 상자가 **접히는 모션** (사용자 지시 2026-08-12).
 *
 * 상자가 그냥 사라지면 "지워졌다"로 읽힌다 — 줄어들며 부모 카드 쪽으로 빨려
 * 들어가야 "접어서 넣었다"가 된다. 그 연출이 끝난 뒤에야 상태를 바꾼다.
 *
 * ## 왜 React state로 안 하나
 *
 * 이 상자는 배치가 정한 자리에 `left/top`으로 앉아 있고 그 값에 이미 전이가
 * 걸려 있다(재배치 때 글과 함께 미끄러지라고). 여기서 렌더를 한 번 더 태우면
 * 두 전이가 섞여 엉뚱한 데로 미끄러진다. 사라지기 직전의 **한 번뿐인 연출**
 * 이므로 DOM을 직접 만지는 편이 맞다 — 드래그 중 연결선을 `dragBus`로 따라
 * 가게 하는 것과 같은 태도다.
 *
 * ## 원점이 왼쪽 가운데인 이유
 *
 * 딸린 것은 **카드 오른쪽 옆**에 붙는다(D163). 부모는 늘 왼쪽에 있으므로
 * 그쪽으로 오므라들어야 어디로 들어갔는지가 보인다.
 */

/** 접히는 시간(ms). 상태를 바꾸는 시점과 묶여 있다. */
export const FOLD_MS = 180;

export function foldAway(el: HTMLElement | null, done: () => void): void {
  if (!el) {
    // 상자를 못 찾으면 연출만 건너뛴다 — 접기 자체가 막히면 안 된다.
    done();
    return;
  }
  el.style.transformOrigin = "left center";
  el.style.transition = `transform ${FOLD_MS}ms ease-in, opacity ${FOLD_MS}ms ease-in`;
  el.style.transform = "scale(.18)";
  el.style.opacity = "0";
  window.setTimeout(done, FOLD_MS);
}
