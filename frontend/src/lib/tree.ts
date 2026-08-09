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

