/**
 * 트리 걷기 — 방향키·방향 버튼이 쓰는 규칙 (D157).
 *
 * ## 왜 "이전/다음"이 부모/자식인가
 *
 * 위/아래를 **트리 순서(DFS)의 앞뒤**로 잡을 수도 있었다. 그런데 그렇게 하면
 * 가지가 갈라진 자리에서 아래로 가는 길이 하나로 정해져 버린다 — 사용자가
 * 요구한 "다음 노드에서 브랜치가 갈라지면 아래 버튼이 갈래 수만큼 쪼개진다"가
 * 성립하지 않는다. 부모/자식으로 잡으면 갈래가 그대로 선택지가 된다.
 *
 * 곧게 이어지는 대화(대부분)에서는 둘이 같다.
 *
 * ## 좌우는 트리(=태그 열)를 옮긴다
 *
 * 같은 트리 안을 위아래로 걷고, 좌우로 다른 주제로 건너뛴다. 도착지는 그
 * 트리의 **뿌리**다 — 남의 가지 한가운데에 떨어지면 어디에 있는지 알 수 없다.
 */

import { buildTrees, isTreeNode, type TreeItem } from "./tree";

export type NavDir = "up" | "down" | "left" | "right";

/** 이 노드의 자식들 (트리 순서). 아래 버튼이 몇 갈래로 쪼개질지가 이 값이다. */
export function branchesOf(items: readonly TreeItem[], id: string | null): string[] {
  if (!id) return [];
  const me = items.find((i) => i.id === id);
  if (!me || !isTreeNode(me)) return [];
  return items
    .filter((i) => isTreeNode(i) && i.parentItemId === id && i.tag === me.tag)
    .sort((a, b) => a.seq - b.seq)
    .map((i) => i.id);
}

/** 이 노드의 부모. 같은 태그로 이어져 있을 때만. */
function parentOf(items: readonly TreeItem[], id: string): string | null {
  const me = items.find((i) => i.id === id);
  if (!me || !isTreeNode(me) || !me.parentItemId) return null;
  const p = items.find((i) => i.id === me.parentItemId);
  return p && isTreeNode(p) && p.tag === me.tag ? p.id : null;
}

/**
 * 태그 순서대로 편 트리 목록. `tagOrder`(열 순서)를 그대로 따른다 —
 * 화면에서 왼쪽에 있는 열이 목록에서도 왼쪽이어야 좌우 이동이 눈과 맞는다.
 */
function treesInColumnOrder(
  items: readonly TreeItem[],
  tagOrder: readonly string[],
): { tag: string; roots: string[] }[] {
  const built = buildTrees(items);
  const byTag = new Map(built.map((t) => [t.tag, t]));
  const seen = new Set<string>();
  const out: { tag: string; roots: string[] }[] = [];
  for (const tag of tagOrder) {
    const t = byTag.get(tag);
    if (t && t.roots.length) {
      out.push({ tag, roots: t.roots });
      seen.add(tag);
    }
  }
  // tagOrder에 없는 트리(막 생긴 태그)는 뒤에 붙인다.
  for (const t of built) {
    if (!seen.has(t.tag) && t.roots.length) out.push({ tag: t.tag, roots: t.roots });
  }
  return out;
}

/**
 * 한 걸음 옮긴 뒤의 노드. 갈 곳이 없으면 null(그 자리에 머문다).
 *
 * `picked`가 없으면 **어느 방향이든 첫 트리의 뿌리로 들어간다** — 아무것도
 * 고르지 않은 상태에서 방향키를 누른 학생의 뜻은 "일단 들어가겠다"이다.
 */
export function navigate(
  items: readonly TreeItem[],
  tagOrder: readonly string[],
  picked: string | null,
  dir: NavDir,
): string | null {
  const trees = treesInColumnOrder(items, tagOrder);
  if (!trees.length) return null;

  const cur = picked ? items.find((i) => i.id === picked) : undefined;
  if (!cur || !isTreeNode(cur)) return trees[0].roots[0] ?? null;

  if (dir === "up") return parentOf(items, cur.id);
  if (dir === "down") return branchesOf(items, cur.id)[0] ?? null;

  const at = trees.findIndex((t) => t.tag === cur.tag);
  if (at < 0) return trees[0].roots[0] ?? null;
  const next = dir === "right" ? at + 1 : at - 1;
  if (next < 0 || next >= trees.length) return null; // 양끝에서는 넘어가지 않는다
  return trees[next].roots[0] ?? null;
}
