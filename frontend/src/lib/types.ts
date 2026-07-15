// Supabase 도메인 타입 (Stage 0 — 인증/공간/프로필 범위)

export interface Profile {
  id: string;
  email: string | null;
  role: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /** D18: 온보딩 1회 완료 플래그. */
  onboarded?: boolean | null;
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

// ── Stage 4b: 교사 컨트롤 패널 ────────────────────────────────────────

export interface TeacherClass {
  id: string;
  name: string | null;
  join_code: string | null;
  created_at: string;
  student_count: number;
}

/** D67: 교사 콘솔 홈 학급 개요(한 행 = 한 학급, 카운트·최근활동 포함). */
export interface TeacherClassOverview {
  id: string;
  name: string | null;
  join_code: string | null;
  created_at: string;
  student_count: number;
  material_count: number;
  last_activity_at: string | null;
}

export interface TeacherStudent {
  user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  role_in_class: string | null;
  joined_at: string;
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
  /** 08 F: 낙관(미확정) 세션 행 — "새 대화" 클릭 즉시 표시, 서버 확정 전. */
  _pending?: boolean;
}

export interface NodeRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  question: string;
  answer: string;
  label: string | null;
  position_x: number | null;
  position_y: number | null;
  created_at: string;
  /** Stage 3a: 이 노드가 가져온 source 노드 id들(기억 연결). */
  connections?: string[] | null;
  /** D32: 이 답변이 RAG로 참고한 자료 출처들(없으면 빈 배열/누락). */
  rag_sources?: RagSource[] | null;
  /**
   * D36: 클라이언트 전용 임시(provisional) 노드 플래그(백엔드 미존재).
   * 전송 즉시 부모 아래에 반투명·점선으로 띄우고, done 시 실노드로 교체.
   */
  _provisional?: boolean;
  /** D46: 이 답변이 이번 턴에 참조한 브랜치 출처들(구노드엔 없음). */
  reference_sources?: ReferenceSource[] | null;
  /**
   * 캔버스 리프 노드 영속분(C5). `attachments.canvas`에 이 노드가 생성한
   * EBS 영상/아트 추천 노드를 담아 세션 재수화 때 복원한다. 그 외 attachments
   * 키(기타 첨부)는 건드리지 않는다. 카드 좌표는 저장하지 않는다 — 프론트
   * d3-force(useTagLayout)가 매 세션 배치를 소유한다.
   */
  attachments?: {
    canvas?: {
      ebs?: { video_id: string; title: string; thumb: string; score?: number }[];
      art?: { slug: string; url: string; title: string; score?: number }[];
    } | null;
    [key: string]: unknown;
  } | null;
}

/** D46: 답변 노드의 참조 출처(비교참조 브랜치). */
export interface ReferenceSource {
  kind: "comparison" | string;
  label: string;
  node_ids: string[];
  leaf_id: string;
  session_id: string;
}

/** D32: RAG 답변의 출처 청크 메타. */
export interface RagSource {
  file_id: string;
  name: string | null;
  seq: number | null;
  distance: number | null;
  snippet: string | null;
  /** D41: 청크 식별자(있을 때만 ⋯ 상세 패널 제공). 구노드엔 없음. */
  chunk_id?: string | null;
}

/** D41: GET /files/chunks/{chunk_id}/context 응답(청크 전문 + 인접 청크). */
export interface ChunkContext {
  file_id: string;
  name: string | null;
  seq: number | null;
  chunk_text: string;
  prev_text: string | null;
  next_text: string | null;
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
    /** D57: 이번 턴 비교참조 출처(있으면). 리페치 전에도 참조 칩 즉시 표시. */
    reference_sources?: ReferenceSource[] | null;
    /** D74: 이번 턴 RAG 출처(있으면). 리페치 전에도 첫 개념 카드 출처 칩 즉시 표시. */
    rag_sources?: RagSource[] | null;
  };
  current_head_id: string | null;
  root_node_id: string | null;
}

// ── Stage 4a: 홈 ─────────────────────────────────────────────────────

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

export interface HomeSummary {
  spaces: HomeSpace[];
  recent_sessions: HomeRecentSession[];
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
  /** D83: 세션 컨텍스트로 연결된 세션(user_upload 전용). */
  session_id?: string | null;
  /** D84: 파일 전문 문자 수(예산 원장 — 워커 기록). */
  context_chars?: number | null;
  created_at: string;
  /** 08 F: 낙관 삽입 미확정 — 캔버스가 파일 노드를 반투명 pending으로 렌더. */
  _pending?: boolean;
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

// ── D34/D35: 턴 상세 + 구조화 contexts ───────────────────────────────

/** D35: 시스템 프롬프트에 들어간 컨텍스트 블록. */
export type LogBlockKind =
  | "system_base"
  | "memory_link"
  | "rag"
  | "comparison"
  | string;

export interface LogContextBlock {
  kind: LogBlockKind;
  order: number;
  source?: string | null;
  raw_text?: string | null;
  node_ids?: string[] | null;
  /** rag 블록의 출처(D32와 동일 형). */
  sources?: RagSource[] | null;
  /** system_prompt 문자열 내 [start, end) char 오프셋. */
  prompt_span?: [number, number] | null;
}

/**
 * D35: ai_logs.contexts 구조화형.
 * 신버전 = { history, blocks[] }. 구버전(boolean 플래그)은 blocks 누락 → 폴백 렌더.
 */
export interface LogContexts {
  history?: { turns: number; chars: number } | null;
  blocks?: LogContextBlock[] | null;
  /** 구버전 boolean 플래그(current_branch/memory_link/rag/comparison 등) 폴백용. */
  [key: string]: unknown;
}

/** D25: 채팅 턴 단위 로그(ai_logs 1행 = 1턴). */
export interface AdminLog {
  id: string;
  owner_id: string;
  session_id: string | null;
  node_id: string | null;
  kind: string | null;
  system_prompt: string | null;
  question: string | null;
  answer: string | null;
  contexts: LogContexts | null;
  skill_calls: unknown[] | null;
  errors: unknown[] | null;
  token_estimate: number | null;
  created_at: string;
}

export interface AdminLogsResponse {
  limit: number;
  offset: number;
  logs: AdminLog[];
}

/** D34: GET /admin/logs/{id} 응답(턴 본체). */
export interface AdminLogDetail {
  log: AdminLog;
}

/** D33: POST /teacher/classes 생성 응답(student_count 없음). */
export interface CreatedClass {
  id: string;
  name: string | null;
  join_code: string | null;
  teacher_id?: string | null;
  created_at: string;
}
