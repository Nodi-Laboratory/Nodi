/** 노드 기억 연결 · 좌표/캔버스 첨부 영속. api.ts(806줄)에서 분리 — D102. */
import { API_BASE, authHeaders, ensureOk } from "./_core";
import { assertRealId } from "@/lib/ids";
import type {
  ConnectionResponse,
} from "@/lib/types";

// ── 노드 기억 연결 (Stage 3a) ────────────────────────────────────────

/** target 노드에 source 노드를 기억 연결로 추가. */
export async function addConnection(
  targetId: string,
  sourceId: string,
): Promise<ConnectionResponse> {
  assertRealId(targetId, "target_node_id"); // D63
  assertRealId(sourceId, "source_node_id");
  const res = await ensureOk(
    await fetch(`${API_BASE}/nodes/${targetId}/connections`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ source_node_id: sourceId }),
    }),
  );
  return res.json();
}

/** target 노드에서 source 기억 연결을 해제. */
export async function removeConnection(
  targetId: string,
  sourceId: string,
): Promise<ConnectionResponse> {
  assertRealId(targetId, "target_node_id"); // D63
  assertRealId(sourceId, "source_node_id");
  const res = await ensureOk(
    await fetch(`${API_BASE}/nodes/${targetId}/connections/${sourceId}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

