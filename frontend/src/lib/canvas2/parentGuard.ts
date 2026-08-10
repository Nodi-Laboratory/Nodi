/**
 * 자식은 부모보다 위로 올라가지 못한다 (사용자 지시 2026-08-09).
 *
 * ## 왜 규칙이 필요한가
 *
 * 트리는 **위에서 아래로** 읽는다(D151: 열 안에서 부모 → 자식 순서). 그런데
 * 좌표는 학생이 자유롭게 옮길 수 있어서(D122), 자식을 부모 위로 끌어올리면
 * 화면의 그림과 실제 관계가 **거꾸로** 보인다. 연결선은 여전히 이어져 있으니
 * 학생 눈에는 "선이 위로 거슬러 올라가는" 이상한 그림이 된다.
 *
 * 그래서 한 줄로 못 박는다: **자식의 윗변은 부모의 아랫변보다 위일 수 없다.**
 *
 * ## 양쪽을 다 막는다
 *
 * 자식만 막으면 **부모를 내리는 것으로 같은 상태를 만들 수 있다.** 규칙이
 * 한쪽에서만 성립하면 규칙이 아니다 — 부모를 끌 때는 자식의 윗변에 걸려
 * 멈춘다.
 *
 * ## 같이 움직이는 것끼리는 서로를 안 막는다
 *
 * 가지 전체를 끌 때(카드 수정 도구) 부모와 자식이 **함께** 간다. 그때 둘의
 * 간격은 안 변하므로 막을 이유가 없다 — 막으면 가지가 통째로 얼어붙는다.
 * 그래서 판정은 **움직이는 집합 밖에 있는 상대**하고만 한다.
 */

export interface GuardRect {
  y: number;
  h: number;
}

export interface GuardInput {
  /** 지금 끌고 있는 아이템 id들. */
  moving: readonly string[];
  /** id → 부모 id (없으면 null). */
  parentOf: (id: string) => string | null;
  /** id → 그 아이템의 세로 범위. 배치 전이면 null. */
  rectOf: (id: string) => GuardRect | null;
  /** 어떤 부모의 자식들. */
  childrenOf: (id: string) => readonly string[];
}

/**
 * 세로 이동량 `dy`가 가질 수 있는 범위 `[min, max]` (world px).
 *
 * `min`이 음수면 그만큼 위로 갈 수 있다는 뜻이다. 걸릴 것이 없으면
 * `[-Infinity, Infinity]`.
 */
export function dyLimits({
  moving,
  parentOf,
  rectOf,
  childrenOf,
}: GuardInput): { min: number; max: number } {
  const inSet = new Set(moving);
  let min = -Infinity;
  let max = Infinity;

  for (const id of moving) {
    const me = rectOf(id);
    if (!me) continue;

    // 위로: 내 윗변이 (밖에 있는) 부모의 아랫변 아래에 있어야 한다.
    const pid = parentOf(id);
    if (pid && !inSet.has(pid)) {
      const p = rectOf(pid);
      if (p) min = Math.max(min, p.y + p.h - me.y);
    }

    // 아래로: 내 아랫변이 (밖에 있는) 자식의 윗변 위에 있어야 한다.
    for (const cid of childrenOf(id)) {
      if (inSet.has(cid)) continue;
      const c = rectOf(cid);
      if (c) max = Math.min(max, c.y - (me.y + me.h));
    }
  }

  /**
   * ⚠️ 이미 어긋나 있는 배치에서는 `min > max`가 될 수 있다.
   *
   * 예전에 옮겨 둔 카드, 자동 배치가 겹쳐 놓은 카드가 그렇다. 그때 범위를
   * 그대로 쓰면 `clamp`가 어느 쪽이든 **큰 값으로 튕겨** 카드가 손과 상관없이
   * 날아간다. 그런 상태에서는 세로를 잠근다(0) — 학생이 가로로는 계속 옮길
   * 수 있고, 관계를 고치면 세로도 풀린다.
   */
  if (min > max) return { min: 0, max: 0 };
  return { min, max };
}

/** `dy`를 규칙 안으로 가둔다. */
export function clampDy(dy: number, limits: { min: number; max: number }): number {
  return Math.min(limits.max, Math.max(limits.min, dy));
}
