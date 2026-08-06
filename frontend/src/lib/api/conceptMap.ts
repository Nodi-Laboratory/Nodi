/**
 * 개념 지도 (D189) — 지금까지 대화한 개념 전부와 비슷한 것끼리의 선.
 *
 * **좌표는 서버가 주지 않는다.** 2D 배치는 화면 크기·확대 배율에 따라야 하므로
 * 브라우저가 힘 배치로 만든다. 서버가 정해 두면 창을 줄일 때마다 어긋난다.
 */
import { API_BASE, authHeaders, ensureOk } from "./_core";
import type { SpaceKind } from "@/lib/types";

export interface ConceptNode {
  id: string;
  session_id: string | null;
  title: string;
  /** 본문 첫 줄만 — 지도는 읽는 곳이 아니라 찾는 곳이다. */
  preview: string;
  tag: string | null;
  created_at: string;
}

/** 두 개념이 가깝다는 표시. `distance = 1 - cosine` (저장소 공통 규약). */
export interface ConceptEdge {
  a: string;
  b: string;
  distance: number;
}

export interface ConceptMapSession {
  id: string;
  title: string | null;
  space_kind: SpaceKind;
  space_ref: string | null;
  updated_at: string;
}

export interface ConceptMapData {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  sessions: ConceptMapSession[];
}

export async function getConceptMap(): Promise<ConceptMapData> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/home/concept-map`, {
      headers: await authHeaders(),
    }),
  );
  return (await res.json()) as ConceptMapData;
}
