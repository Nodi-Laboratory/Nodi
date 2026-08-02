/**
 * 태그별 대화 트리 (D151).
 *
 * ## 무엇을 되살렸나
 *
 * 아주 오래된 Nodi(Zanviq/Nodi)는 대화가 **노드 트리**였다 —
 * `nodes.parent_id`로 이어지고 `session.current_head_id`가 지금 자리를
 * 가리켰다. 그 구조를 캔버스 v2에 옮기되, 한 가지를 바꾼다:
 *
 *     옛 Nodi   세션 하나 = 트리 하나 (분기는 컨텍스트를 **줄이려고** 갈랐다)
 *     지금      **태그 하나 = 트리 하나** (컨텍스트는 다 넣고, 트리는 초점이다)
 *
 * 컨텍스트를 자르지 않는 이유는 사용자 결정이다(2026-08-02): "그 철학을
 * 적용하지 않아도 된다. 그냥 모든 컨텍스트를 다 붙여도 돼. 대신 AI가 그걸
 * 판단할 수 있도록 해야 해." 그래서 트리는 **잘라내는 장치가 아니라 순서와
 * 초점을 주는 장치**다 — 카드를 태그별·트리 순서로 정렬해 넣고, 학생이 지금
 * 어느 트리에서 묻는지를 프롬프트에 명시한다.
 *
 * ## 간선은 왜 이것뿐인가
 *
 * 사용자 요구는 "거미줄처럼 연결선이 너무 많지 않았으면. 마인드맵처럼".
 * 그래서 규칙을 셋으로 묶었다:
 *
 *   1. **노드는 AI 개념 카드뿐**이다. 학생 메모·도판은 트리에 넣지 않는다.
 *   2. **부모는 최대 하나**다(`parent_item_id`). 간선 수 = 노드 수 − 트리 수라
 *      원리적으로 선형이다. 임의의 두 노드를 이어 붙이는 경로가 아예 없다.
 *   3. **같은 태그끼리만** 잇는다. 부모와 태그가 달라지면(학생이 분류를 바꾸면)
 *      간선은 조용히 사라지고 그 노드가 새 트리의 뿌리가 된다.
 *
 * 저장은 이미 있는 열 하나로 끝난다 — `canvas_items.parent_item_id`. 스키마를
 * 늘리지 않는다.
 */

/** 트리 판정에 필요한 최소 정보. `CanvasItem`이 그대로 들어맞는다. */
export interface TreeItem {
  id: string;
  tag: string | null;
  parentItemId: string | null;
  seq: number;
  kind: string;
  source: string;
}

/** 부모 → 자식. **방향 그래프다**(지도에서 화살표로 그린다). */
export interface TreeEdge {
  from: string;
  to: string;
  /** 두 노드가 속한 트리(=태그). 색을 태그별로 줄 때 쓴다. */
  tag: string;
}

/** 트리 하나 = 태그 하나. */
export interface Tree {
  tag: string;
  /** 뿌리들. 보통 하나지만, 학생이 분류를 바꾸면 여럿이 될 수 있다. */
  roots: string[];
  /** 트리 순서(뿌리 → 깊이 우선, 형제는 seq 순)로 편 노드. */
  order: string[];
  /** 노드별 깊이(뿌리가 0). 배치의 들여쓰기가 이 값을 쓴다. */
  depth: Map<string, number>;
}

/** 트리에 들어가는 노드인가 — AI가 쓴 개념 카드만. */
export function isTreeNode(i: TreeItem): boolean {
  return i.kind === "concept" && i.source === "ai" && !!i.tag;
}

/**
 * 실제로 이어져 있는 부모 id. 없으면 null.
 *
 * 부모가 사라졌거나(삭제) 태그가 달라졌으면 **끊어진 것으로 본다.** 화면에서
 * 없어진 노드로 선이 뻗거나, 분류가 다른 두 열 사이를 선이 가로지르는 일이
 * 없어야 한다.
 */
function linkedParent(i: TreeItem, byId: Map<string, TreeItem>): string | null {
  if (!i.parentItemId || !isTreeNode(i)) return null;
  const p = byId.get(i.parentItemId);
  if (!p || !isTreeNode(p)) return null;
  return p.tag === i.tag ? p.id : null;
}

/**
 * 그릴 간선들. 지도와 캔버스가 **같은 목록**을 쓴다 — 둘이 다르면 학생이
 * 지도에서 본 관계를 캔버스에서 못 찾는다.
 */
export function treeEdges(items: readonly TreeItem[]): TreeEdge[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: TreeEdge[] = [];
  for (const i of items) {
    const p = linkedParent(i, byId);
    if (p) out.push({ from: p, to: i.id, tag: i.tag as string });
  }
  return out;
}

/**
 * 태그별 트리. 태그 순서는 **첫 등장 순서**다(열 순서와 같아야 지도와 캔버스가
 * 어긋나지 않는다).
 *
 * 순환은 방어한다 — 데이터가 꼬여도 화면이 멈추면 안 된다.
 */
export function buildTrees(items: readonly TreeItem[]): Tree[] {
  const nodes = items.filter(isTreeNode).slice().sort((a, b) => a.seq - b.seq);
  const byId = new Map(nodes.map((i) => [i.id, i]));

  const kids = new Map<string, TreeItem[]>();
  const rootsByTag = new Map<string, string[]>();
  const tagOrder: string[] = [];

  for (const n of nodes) {
    const tag = n.tag as string;
    if (!rootsByTag.has(tag)) {
      rootsByTag.set(tag, []);
      tagOrder.push(tag);
    }
    const p = linkedParent(n, byId);
    if (p) {
      const arr = kids.get(p) ?? [];
      arr.push(n);
      kids.set(p, arr);
    } else {
      rootsByTag.get(tag)!.push(n.id);
    }
  }

  return tagOrder.map((tag) => {
    const roots = rootsByTag.get(tag) ?? [];
    const order: string[] = [];
    const depth = new Map<string, number>();
    const seen = new Set<string>();
    const walk = (id: string, d: number) => {
      if (seen.has(id)) return; // 순환 방어
      seen.add(id);
      order.push(id);
      depth.set(id, d);
      // 형제는 생성 순서다 — nodes를 seq로 정렬해 넣었으므로 이미 그 순서다.
      for (const c of kids.get(id) ?? []) walk(c.id, d + 1);
    };
    for (const r of roots) walk(r, 0);
    return { tag, roots, order, depth };
  });
}

/**
 * 이 태그 트리에서 **다음 카드가 붙을 자리**(head).
 *
 * "가장 최근에 선택했거나 답을 달았던 노드"라는 사용자 정의를 그대로 옮겼다:
 * 학생이 고른 노드가 이 태그에 있으면 그 자리, 없으면 가장 나중에 만들어진
 * 노드다. 새로고침하면 초점이 사라지므로 자연히 후자로 떨어진다 — 그래도
 * "마지막 답 뒤에 이어 붙는다"는 기대는 지켜진다.
 */
export function headOf(
  items: readonly TreeItem[],
  tag: string,
  focusId: string | null,
): string | null {
  const byId = new Map(items.map((i) => [i.id, i]));
  const focus = focusId ? byId.get(focusId) : undefined;
  if (focus && isTreeNode(focus) && focus.tag === tag) return focus.id;
  let best: TreeItem | null = null;
  for (const i of items) {
    if (!isTreeNode(i) || i.tag !== tag) continue;
    if (!best || i.seq > best.seq) best = i;
  }
  return best?.id ?? null;
}

/** 이번 턴에 만들어진 카드 하나 — 부모를 정해 줘야 할 대상. */
export interface IncomingCard {
  id: string;
  tag: string | null;
}

/**
 * 새 카드들의 부모를 정한다 (D151의 핵심 규칙).
 *
 * ```
 * 같은 턴에 같은 태그가 또 나왔다  → 직전 카드에 잇는다      (한 줄기로 이어진다)
 * 학생이 고른 노드의 태그와 같다    → 그 노드에서 갈라진다    (분기)
 * 이미 있는 태그다                  → 그 트리의 head 뒤       (이어 붙이기)
 * 처음 보는 태그다                  → 뿌리 (새 트리)
 * ```
 *
 * 한 턴이 같은 태그 카드 셋을 뱉으면 **사슬**로 잇는다. 셋을 같은 부모 밑에
 * 형제로 달면 폭이 넓어지고 순서가 안 보인다 — 사용자 요구가 "생성 순서대로
 * 연결"이었다.
 *
 * @param existing 이미 캔버스에 있는 것들
 * @param incoming 이번 턴에 생긴 카드들 (**생성 순서**)
 * @param focusId  학생이 고른 노드 (없으면 null)
 */
export function assignParents(
  existing: readonly TreeItem[],
  incoming: readonly IncomingCard[],
  focusId: string | null,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  /** 이번 턴에 이 태그로 마지막에 만든 카드. 사슬을 잇는 데 쓴다. */
  const lastInTurn = new Map<string, string>();

  for (const card of incoming) {
    const tag = (card.tag || "").trim();
    if (!tag) {
      out.set(card.id, null); // 분류가 없으면 트리에 넣지 않는다
      continue;
    }
    const chained = lastInTurn.get(tag);
    out.set(card.id, chained ?? headOf(existing, tag, focusId));
    lastInTurn.set(tag, card.id);
  }
  return out;
}

/**
 * 턴이 끝난 뒤 초점을 어디에 둘 것인가.
 *
 * 초점을 그대로 두면 다음 질문이 **같은 노드에서 또 갈라져** 형제가 계속
 * 쌓인다. 이어 물을수록 옆으로 퍼지는 모양이 되는데, 학생이 기대하는 것은
 * 방금 받은 답 **뒤에** 이어지는 것이다. 그래서 초점이 있던 태그의 새 카드가
 * 있으면 그 마지막 카드로 옮긴다.
 *
 * 초점이 없었으면 만들지 않는다 — 아래 입력창으로 그냥 물은 것은 "어느 트리도
 * 고르지 않았다"는 뜻이고, 그 상태를 임의로 바꾸면 다음 턴의 프롬프트가
 * 학생이 고르지도 않은 트리를 가리키게 된다.
 */
export function nextFocus(
  focusId: string | null,
  focusTag: string | null,
  created: readonly { id: string; tag: string | null }[],
): string | null {
  if (!focusId || !focusTag) return focusId;
  let last: string | null = null;
  for (const c of created) if ((c.tag || "").trim() === focusTag) last = c.id;
  return last ?? focusId;
}
