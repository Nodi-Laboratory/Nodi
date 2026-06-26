import type { NodeRow } from "@/lib/types";

export interface TreeNode {
  data: NodeRow;
  children: TreeNode[];
}

export function buildById(nodes: NodeRow[]): Map<string, NodeRow> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** 노드의 조상체인 (루트 → 해당 노드, 시간 순). 형제 분기는 제외. */
export function ancestorChain(
  nodeId: string | null,
  byId: Map<string, NodeRow>,
): NodeRow[] {
  const chain: NodeRow[] = [];
  let cur = nodeId;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) break; // 순환 보호
    seen.add(cur);
    const n = byId.get(cur);
    if (!n) break;
    chain.push(n);
    cur = n.parent_id;
  }
  return chain.reverse();
}

/** 루트 → nodeId 경로상의 id 집합 (현재경로 하이라이트용). */
export function pathIdSet(
  nodeId: string | null,
  byId: Map<string, NodeRow>,
): Set<string> {
  const set = new Set<string>();
  let cur = nodeId;
  while (cur) {
    if (set.has(cur)) break;
    set.add(cur);
    cur = byId.get(cur)?.parent_id ?? null;
  }
  return set;
}

/** 플랫 노드 배열 → d3.hierarchy용 중첩 트리. 루트 1개 가정(없으면 최초 무부모 노드). */
export function buildNested(
  nodes: NodeRow[],
  rootNodeId?: string | null,
): TreeNode | null {
  if (nodes.length === 0) return null;
  const byId = buildById(nodes);
  const childrenMap = new Map<string, NodeRow[]>();
  let rootRaw: NodeRow | null = null;

  for (const n of nodes) {
    if (n.parent_id && byId.has(n.parent_id)) {
      const arr = childrenMap.get(n.parent_id) ?? [];
      arr.push(n);
      childrenMap.set(n.parent_id, arr);
    } else if (!rootRaw) {
      rootRaw = n;
    }
  }

  if (rootNodeId && byId.has(rootNodeId)) {
    rootRaw = byId.get(rootNodeId)!;
  }
  if (!rootRaw) return null;

  // created_at 순으로 자식 정렬 (안정적 레이아웃)
  const sortByCreated = (a: NodeRow, b: NodeRow) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? "");

  const build = (raw: NodeRow, seen: Set<string>): TreeNode => {
    seen.add(raw.id);
    const kids = (childrenMap.get(raw.id) ?? [])
      .filter((c) => !seen.has(c.id))
      .sort(sortByCreated);
    return { data: raw, children: kids.map((c) => build(c, seen)) };
  };

  return build(rootRaw, new Set<string>());
}
