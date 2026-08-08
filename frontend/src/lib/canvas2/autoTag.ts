/**
 * 떼어낸 묶음에 붙일 **새 분류 이름** (D211 10 = D210 6-2 다시 읽기).
 *
 * ## 무엇이 "새 태그"인가
 *
 * 처음에는 태그 메뉴에서 학생이 새 분류를 만드는 것을 막는 것으로 읽었다.
 * 사용자가 말한 것은 **시스템이 자동으로 다는 것**이었다(2026-08-08) — 가지를
 * 떼어내면 그 묶음이 자기 열을 갖게 된다.
 *
 * ## 카드 한 장은 아직 다른 갈래가 아니다
 *
 * 이어진 카드가 **2장 이상**일 때만 새 분류를 만든다. 한 장은 그냥 옮긴
 * 카드이고, 거기에 분류를 하나씩 만들면 열이 카드 수만큼 생겨 배치가
 * 무의미해진다(D135가 겪은 파편화와 같은 자리다).
 *
 * ## 이름은 뿌리의 제목에서 가져온다
 *
 * 지어내지 않는다 — "새 분류 1"은 학생에게 아무것도 말해 주지 않는다. 떼어낸
 * 가지의 **맨 위 카드 제목**이 그 묶음이 무엇인지 이미 말하고 있다.
 */

/** 열 라벨이 아이템 폭을 넘지 않게 하는 상한(TagPicker와 같은 값). */
const MAX_TAG = 16;

export interface AutoTagInput {
  /** 떼어낸 가지의 뿌리 제목. */
  rootTitle: string | null | undefined;
  /** 이 묶음에 이어져 있는 카드 수(자기 포함). */
  groupSize: number;
  /** 이미 쓰이고 있는 분류들 — 겹치면 안 된다. */
  taken: readonly string[];
}

/**
 * 붙일 분류 이름. **한 장짜리이거나 이름을 못 만들면 `null`**(=분류 없음).
 *
 * 겹치면 뒤에 번호를 붙인다. 같은 이름이 둘이면 열이 하나로 합쳐져, 학생이
 * 방금 떼어낸 것이 원래 자리로 돌아간 것처럼 보인다.
 */
export function autoTagFor({ rootTitle, groupSize, taken }: AutoTagInput): string | null {
  if (groupSize < 2) return null;
  const base = (rootTitle ?? "").trim().slice(0, MAX_TAG);
  if (!base) return null;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n <= 99; n++) {
    const cand = `${base.slice(0, MAX_TAG - 2)} ${n}`;
    if (!used.has(cand)) return cand;
  }
  // 99개까지 겹치는 일은 없다 — 있어도 분류 없음으로 두는 편이 안전하다.
  return null;
}
