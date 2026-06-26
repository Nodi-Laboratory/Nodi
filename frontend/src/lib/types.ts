// Supabase 도메인 타입 (Stage 0 — 인증/공간/프로필 범위)

export interface Profile {
  id: string;
  email: string | null;
  role: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

export interface ClassRow {
  id: string;
  name: string | null;
  join_code: string | null;
}

/** class_members ↔ classes 임베드 조회 결과 */
export interface MyClass {
  class_id: string;
  role_in_class: string | null;
  classes: ClassRow | null;
}

// ── Stage 1: 트리 대화 (백엔드 FastAPI 계약) ──────────────────────────

export type SpaceKind = "personal" | "class";

export interface SessionRow {
  id: string;
  owner_id?: string;
  space_kind?: SpaceKind;
  space_ref?: string | null;
  title: string | null;
  emoji?: string | null;
  root_node_id: string | null;
  current_head_id: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface NodeRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  question: string;
  answer: string;
  label: string | null;
  is_navigator: boolean;
  navigator_question: string | null;
  position_x: number | null;
  position_y: number | null;
  created_at: string;
  /** Stage 2: 해당 턴의 태그 이름들. 새로 만든 노드는 done.node.tags로 즉시 채움. */
  tags?: string[] | null;
  /** Stage 3a: 이 노드가 가져온 source 노드 id들(기억 연결). */
  connections?: string[] | null;
}

/** Stage 3a: 연결 add/remove 응답(갱신된 connections 배열). */
export interface ConnectionResponse {
  node_id: string;
  connections: string[];
}

export interface SessionDetail {
  session: SessionRow;
  nodes: NodeRow[];
}

// ── Stage 2: 개념 태그 ────────────────────────────────────────────────

export interface TagRow {
  id: string;
  name: string;
  usage_count: number;
  space_kind: SpaceKind;
  space_ref: string | null;
  created_at: string;
}

export interface CooccurrenceRow {
  tag_a: string;
  tag_b: string;
  name_a: string;
  name_b: string;
  count: number;
}

// ── /chat/stream SSE 이벤트 ──────────────────────────────────────────

export interface ChatStartEvent {
  session_id: string;
  parent_node_id: string | null;
}

export interface ChatDoneEvent {
  node: {
    id: string;
    parent_id: string | null;
    label: string | null;
    tags?: string[] | null;
  };
  current_head_id: string | null;
  root_node_id: string | null;
}

/** Stage 2: done 다음, 네비게이터 게이트 발동 턴에서만 옴. */
export interface ChatNavigatorEvent {
  nodes: Array<{
    id: string;
    parent_id: string | null;
    navigator_question: string;
  }>;
}

// ── Stage 4a: 홈 + 총괄 AI(overseer) ─────────────────────────────────

export interface HomeSpace {
  space_kind: SpaceKind;
  space_ref: string | null;
  name: string | null;
  role_in_class: string | null;
}

export interface HomeRecentSession {
  id: string;
  title: string | null;
  emoji: string | null;
  space_kind: SpaceKind;
  space_ref: string | null;
  updated_at: string;
}

export interface HomeConcept {
  id: string;
  name: string;
  usage_count: number;
}

export interface HomeSummary {
  spaces: HomeSpace[];
  recent_sessions: HomeRecentSession[];
  top_concepts: HomeConcept[];
}

export interface HomeSuggestion {
  question: string;
  seed_question: string;
  space_kind: "personal";
  space_ref: string | null;
}

export interface HomeSuggestions {
  suggestions: HomeSuggestion[];
}

/** 총괄 AI done 액션. */
export type OverseerAction =
  | {
      action: "create_session";
      label: string;
      space_kind: SpaceKind;
      space_ref: string | null;
      seed_question: string;
    }
  | { action: "open_session"; label: string; session_id: string };

export interface OverseerDoneEvent {
  actions: OverseerAction[];
}

// ── Stage 3b: 파일 / RAG ─────────────────────────────────────────────

export type FileStatus =
  | "uploaded"
  | "splitting"
  | "embedding"
  | "indexed"
  | "partial"
  | "failed";

export interface FileRow {
  id: string;
  kind?: string | null;
  name?: string | null;
  filename?: string | null;
  storage_path?: string | null;
  mime?: string | null;
  size_bytes: number | null;
  status: FileStatus;
  chunk_total: number | null;
  chunk_done: number | null;
  error?: string | null;
  created_at: string;
}

// ── Stage 4c: 관리자 ─────────────────────────────────────────────────

export type UserRole = "student" | "teacher" | "admin";

export interface AdminUser {
  id: string;
  email: string | null;
  role: UserRole | string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface AdminSetting {
  key: string;
  value: unknown;
  updated_at: string | null;
  updated_by: string | null;
}

export interface AdminUsageUser {
  owner_id: string;
  email: string | null;
  total_tokens: number;
  step_count: number;
}

export interface AdminUsage {
  partial: boolean;
  note: string;
  by_user: AdminUsageUser[];
}

export interface AdminLogStep {
  seq: number;
  thought: string | null;
  skill: string | null;
  input: unknown;
  observation: unknown;
  tokens: number | null;
  created_at: string;
}

export interface AdminLogSession {
  id: string;
  owner_id: string;
  session_id: string | null;
  kind: string | null;
  created_at: string;
  ai_steps: AdminLogStep[];
}

export interface AdminLogsResponse {
  limit: number;
  offset: number;
  sessions: AdminLogSession[];
}
