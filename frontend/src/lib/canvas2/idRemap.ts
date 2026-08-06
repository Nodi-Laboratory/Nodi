/**
 * 임시 id → 서버 id 교체가 일어날 때, **그 id를 가리키던 상태를 함께 옮긴다** (D187).
 *
 * ## 왜 필요한가
 *
 * 스트리밍 카드는 임시 id(`tmp-N`)로 먼저 그려지고 저장이 끝나면 서버 UUID로
 * 갈린다(`useCanvasItems.replaceTemp`). 그런데 초점·선택·편집은 **워크스페이스
 * state**라 그대로 남아 허공을 가리킨다:
 *
 *     초점(pickedId)    인용 칩이 파생값이라(D151) 칩이 사라진다
 *     선택(selectedIds) 끌기·지우기가 조용히 아무것도 안 한다
 *     편집(editingId)   쓰던 입력창이 닫힌다
 *
 * 실측 2026-08-06: 답이 뜨자마자 카드를 누르면 초점은 `tmp-1`인데 저장 뒤
 * 화면에는 UUID만 남아 칩이 없어졌다. **화면에도 로그에도 안 드러난다.**
 *
 * ## 왜 lib인가
 *
 * 컴포넌트 안에 두면 확인할 방법이 e2e뿐인데 CI는 e2e를 돌리지 않는다(라이브
 * 스택이 필요하다). 순수 함수로 빼야 회귀가 단위 테스트로 잡힌다 — `connector`
 * 기하를 lib에 둔 것과 같은 이유다(D126).
 */

/** 실제로 **바뀐** id만 담은 표. 안 바뀐 것은 넣지 않는다. */
export function idRemap(
  tempIds: readonly string[],
  saved: readonly { id: string }[],
): Map<string, string> {
  const moved = new Map<string, string>();
  tempIds.forEach((from, i) => {
    const to = saved[i]?.id;
    if (to && to !== from) moved.set(from, to);
  });
  return moved;
}

/** 단일 id를 옮긴다. 표에 없으면 그대로(지워진 것이 아니라 안 바뀐 것이다). */
export function remapId(
  cur: string | null,
  moved: ReadonlyMap<string, string>,
): string | null {
  if (!cur) return cur;
  return moved.get(cur) ?? cur;
}

/**
 * 집합을 옮긴다.
 *
 * **바뀐 것이 없으면 같은 객체를 돌려준다.** 새 Set을 만들면 이 값을 받는
 * 아이템 전부의 `memo`가 깨진다(D145 — 실측으로 글 하나 클릭에 128회 렌더됐다).
 */
export function remapIdSet(
  cur: ReadonlySet<string>,
  moved: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  if (!moved.size || !cur.size) return cur;
  let changed = false;
  const next = new Set<string>();
  for (const id of cur) {
    const to = moved.get(id);
    if (to) changed = true;
    next.add(to ?? id);
  }
  return changed ? next : cur;
}
