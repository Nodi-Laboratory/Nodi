// Concept-card canvas domain types (ported/adapted from Nodi-figma §3).
// The figma `svg`/`artRef`/`ebs` fields are dropped; illustrations now come from
// the /art/search retrieval layer (`art`), and concepts carry an `embedding` +
// `groupId` for the semantic-similarity concept tree.

import type { RagSource } from "@/lib/types";

export interface Token {
  ch: string;
  b: boolean; // bold  (**...**)
  h: boolean; // highlight (==...==)
}

export interface Block {
  type: "p";
  tokens: Token[];
  typing: boolean;
}

export interface ConceptArt {
  slug: string;
  url: string;
}

export interface Concept {
  id: string; // "c1","c2"… assigned by reducer order (deterministic)
  title: string;
  cluster: string; // free-form category the model chose
  blocks: Block[];
  related: string[]; // @related titles
  x: number;
  y: number; // 09: 서버 place 이벤트가 결정한 좌표(격자 계산 제거)
  /** 09: place가 서버에 저장한 카드 높이. 리플레이 시 실림(Task 8 ConceptCard가 우선 사용). */
  h?: number;
  done: boolean;
  art?: ConceptArt | null; // resolved via /art/search on `cend`
  embedding?: number[] | null; // query embedding returned by /art/search
  groupId?: string | null; // semantic-similarity group assignment
  /** D74: 이 턴(노드)의 RAG 출처 — 턴의 첫 개념에만 부착(출처 칩 푸터). */
  sources?: RagSource[] | null;
  /** /retrieve 선행 잠정 플레이스홀더 — 첫 cstart에서 승격(제목/좌표 확정). */
  pending?: boolean;
}

/**
 * C6: 캔버스 리프 노드(영상/삽화) — 개념 곁에 스폰되는 비스트리밍 노드.
 * id는 "l1","l2"… 삽입 순서(리플레이도 동일 순서 → 결정적).
 */
export interface CanvasLeafNode {
  id: string;
  type: "video" | "art";
  x: number;
  y: number;
  conceptId?: string; // 곁에 배치된 개념 id (near 앵커)
  video?: { videoId: string; title: string; thumb: string };
  art?: { slug: string; url: string; title: string };
}

export interface ConceptGroup {
  id: string; // stable: `grp-${repConceptId}`
  label: string; // representative concept title
  memberIds: string[]; // concept.id members of this group
  centroid: number[]; // running mean embedding (empty when no embeddings)
  repConceptId: string; // camera target when the group is clicked
}

// Incremental parser event stream (1:1 with the applyEvent reducer).
export type ParserEvent =
  | { t: "reply-start" }
  | { t: "reply"; ch: string }
  | { t: "cstart"; concept: { title: string; cluster: string } }
  | { t: "bstart"; block: { type: "p" } }
  | { t: "delta"; ch: string; b?: boolean; h?: boolean }
  | { t: "bend" }
  | { t: "related"; titles: string[] }
  | { t: "cend" }
  | { t: "done" };

export type EmitFn = (ev: ParserEvent) => void;
