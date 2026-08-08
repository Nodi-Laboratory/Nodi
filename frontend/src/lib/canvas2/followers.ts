/**
 * 카드에 **딸린 것들** (D211 6).
 *
 * 카드가 움직일 때 함께 가야 하는 것은 카드 상자만이 아니다. 도판·강의 클립,
 * 질문 방향성 말풍선처럼 "그 카드 옆에 붙어 있는" 것들이 화면에 여럿 있고,
 * 이들이 안 따라오면 **관계가 끊겨 보인다** — 연결선을 따라가게 만든 것과
 * 똑같은 이유다(사용자 지적 2026-08-08).
 *
 * ## 왜 DOM 표식인가
 *
 * 드래그와 밀어내기는 **React를 거치지 않는다**(D124·D207). 딸린 것 목록을
 * prop으로 내리면 카드가 하나 움직일 때마다 트리 전체의 memo가 깨진다.
 * 붙는 쪽이 `data-follows`에 주인 카드 id를 적어 두면, 미는 쪽은 속성 조회
 * 한 번으로 끝난다(마이크로초 단위다).
 *
 * ## 한 곳에서만 정한다
 *
 * 드래그(`TextItem`)와 밀어내기(`useCardPush`)가 **같은 목록**을 써야 한다.
 * 둘이 각자 훑으면 하나를 고칠 때 다른 하나가 어긋나고, 그 어긋남은 화면
 * 에서만 보인다.
 */

/** 붙는 쪽이 주인 카드 id를 적어 두는 속성. */
export const FOLLOWS = "data-follows";

/**
 * 이 카드들에 딸린 요소 전부(카드 상자 자신은 빼고).
 *
 * 주인이 여럿일 일은 없지만 같은 카드에 여럿이 붙는 것은 흔하다(도판 셋 +
 * 말풍선 하나).
 */
export function followerEls(ids: Iterable<string>): HTMLElement[] {
  const out: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const id of ids) {
    if (!id) continue;
    const found = document.querySelectorAll<HTMLElement>(
      `[${FOLLOWS}="${CSS.escape(id)}"]`,
    );
    for (const el of found) {
      // 카드 상자 자신이 딸린 것으로도 잡히면 두 번 밀린다.
      if (el.hasAttribute("data-canvas-item") && ids instanceof Set && ids.has(el.getAttribute("data-canvas-item") ?? "")) {
        continue;
      }
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}
