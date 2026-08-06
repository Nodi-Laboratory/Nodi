/**
 * 클립 카드에 어느 썸네일을 쓸지 (D190).
 *
 * ## 왜 우리가 고르나
 *
 * EBS 썸네일을 가져올 방법이 없어(저작권·차단) 관리자가 올려 둔 그림 중 하나를
 * 보여 준다(사용자 결정 2026-08-06). 실제 그 강의의 장면은 아니지만 **카드가
 * 무엇인지는 말해 준다.**
 *
 * ## "랜덤"이지만 **매번 같아야** 한다
 *
 * 볼 때마다 다른 그림이 나오면 학생이 어제 본 카드를 못 알아본다. 새로고침
 * 한 번에 지도가 달라지는 것과 같은 문제다. clip id에서 뽑으면 **그 클립은
 * 언제나 같은 그림**이면서 클립끼리는 골고루 흩어진다.
 *
 * 서버가 고르지 않는 이유도 같다 — 매 요청 무작위면 그 성질을 잃는다.
 */

/**
 * 문자열 → 0 이상의 정수. FNV-1a.
 *
 * 암호용이 아니라 **재현성**용이다. `lib/home/conceptLayout.ts`에도 같은 해시가
 * 있는데, 지금 두 화면을 다른 사람이 동시에 고치고 있어 일부러 합치지 않았다 —
 * 여덟 줄 중복이 두 작업을 얽는 것보다 싸다. 한쪽이 잠잠해지면 합쳐라.
 */
function hashInt(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 이 클립이 쓸 썸네일 id. 올라온 그림이 없으면 null.
 *
 * 목록 순서가 바뀌어도(새 그림을 올리면 최신순이라 앞이 밀린다) 같은 클립이
 * 같은 그림을 갖도록 **id로 정렬한 뒤** 고른다. 목록 위치로 고르면 관리자가
 * 그림 한 장을 올릴 때마다 학생들의 카드가 전부 다른 그림으로 바뀐다.
 */
export function pickThumbId(
  clipId: string,
  thumbIds: readonly string[],
): string | null {
  if (!thumbIds.length) return null;
  const stable = [...thumbIds].sort();
  return stable[hashInt(clipId) % stable.length];
}
