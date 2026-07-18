// Concept-card canvas domain types (ported/adapted from Nodi-figma §3).
// D94: EBS 영상·SVG 아트 리프와 /art/search 임베딩 그룹핑 관련 타입
// (ConceptArt/ConceptGroup, Concept.art/embedding/groupId) 제거 —
// 클러스터링은 자유 태그(useTagLayout), 리프는 교과서 figure만 남는다.

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
  /** D74: 이 턴(노드)의 RAG 출처 — 턴의 첫 개념에만 부착(출처 칩 푸터). */
  sources?: RagSource[] | null;
  /** /retrieve 선행 잠정 플레이스홀더 — 첫 cstart에서 승격(제목/좌표 확정). */
  pending?: boolean;
}

/**
 * C6: 캔버스 리프 노드(교과서 figure) — 개념 곁에 스폰되는 비스트리밍 노드.
 * D94: video/art 리프 제거.
 */
export interface CanvasLeafNode {
  id: string;
  type: "figure";
  x: number;
  y: number;
  conceptId?: string; // 곁에 배치된 개념 id (near 앵커)
  // D87: 교과서 figure 리프. url은 signed(만료 有) — 재수화 시 url=""로 먼저
  // 배치하고 getFigure로 비동기 재발급, FigureNode의 onError도 1회 재발급.
  figure?: { figureId: string; url: string; caption: string; page?: number };
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
