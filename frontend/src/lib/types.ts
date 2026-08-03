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
  created_at: string;
  /** D32: 이 답변이 RAG로 참고한 자료 출처들(없으면 빈 배열/누락). */
  rag_sources?: RagSource[] | null;
  /**
   * D36: 클라이언트 전용 임시(provisional) 노드 플래그(백엔드 미존재).
   * 전송 즉시 부모 아래에 반투명·점선으로 띄우고, done 시 실노드로 교체.
   */
  _provisional?: boolean;
  /**
   * 캔버스 리프 노드 영속분(C5). `attachments.canvas`에 이 노드가 생성한
   * 교과서 figure 추천 노드를 담아 세션 재수화 때 복원한다(D94: ebs/art 제거 —
   * 구 노드의 잔존 키는 무시). 그 외 attachments 키(기타 첨부)는 건드리지
   * 않는다. 카드 좌표는 저장하지 않는다 — 프론트 d3-force(useTagLayout)가
   * 매 세션 배치를 소유한다.
   */
  attachments?: {
    canvas?: {
      figures?: {
        figure_id: string;
        file_id: string;
        page?: number;
        caption?: string;
        score?: number;
      }[];
    } | null;
    [key: string]: unknown;
  } | null;
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
    /** D74: 이번 턴 RAG 출처(있으면). 리페치 전에도 첫 개념 카드 출처 칩 즉시 표시. */
    rag_sources?: RagSource[] | null;
  };
  current_head_id: string | null;
  root_node_id: string | null;
  /**
   * D109: ReAct 경로에서 도판을 **스킬이** 찾는다. 예전에는 프론트가 SSE 전에
   * `/retrieve`를 선행 호출해 미리 알고 있었지만, 이제 done에 실려 온다.
   * (백엔드 `figures.figure_item()`의 snake_case 형태 그대로.)
   */
  figures?: Array<{
    figure_id: string;
    file_id: string;
    page?: number | null;
    caption?: string;
    url?: string | null;
    score?: number;
  }> | null;
  /** D149: 강의 클립 추천. 스킬이 찾아 done에 실어 보낸다(snake_case). */
  clips?: Array<{
    clip_id: string;
    title: string;
    start_sec: number;
    timeline_label: string;
    page_url: string;
    video_title?: string;
    score?: number;
  }> | null;
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
  | "tag_guide" // D90: 자유 태그 분류 가이드 블록(백엔드 task5-1)
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

/**
 * D113: 스킬 호출 1건의 트레이스.
 *
 * 스킬 **설명**은 여기 없다 — 매 턴 같은 문자열을 복제할 이유가 없어 서버가
 * 담지 않는다. 콘솔이 /admin/skills 카탈로그와 `skill` 이름으로 이어 붙인다.
 */
export interface SkillTrace {
  skill: string;
  step?: number;
  args?: Record<string, unknown> | null;
  ok?: boolean;
  skipped?: boolean;
  message?: string | null;
  error_code?: string | null;
  duration_ms?: number | null;
  /** 스킬이 돌려준 데이터. 4000자를 넘으면 `_truncated`가 붙는다. */
  data?: Record<string, unknown> | null;
}

/** D113: LLM 호출 1회의 실측 사용량. */
export interface LlmCallUsage {
  stage: "decide" | "answer" | string;
  step?: number;
  prompt?: number;
  completion?: number;
  total?: number;
  cached?: number;
}

/**
 * D113: 턴의 **실측** 토큰. 측정된 호출이 하나도 없으면 `{}`다 —
 * 그 자리에 어림값(token_estimate)을 채우지 않는다.
 */
export interface TurnTokens {
  prompt?: number;
  completion?: number;
  total?: number;
  cached?: number;
  calls?: LlmCallUsage[];
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
  skill_calls: SkillTrace[] | null;
  errors: unknown[] | null;
  /** 글자수/4 어림. 실측이 아니다 — 실측은 `tokens`. */
  token_estimate: number | null;
  tokens?: TurnTokens | null;
  /** 'react' | 'legacy'. D113 이전 로그는 null. */
  route?: string | null;
  model?: string | null;
  duration_ms?: number | null;
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

// ── D113: 운영 콘솔 ──────────────────────────────────────────────────

type CountMap = Record<string, number>;

export interface AdminOverview {
  users: { total: number; by_role: CountMap };
  classes: number;
  sessions: { total: number; by_space: CountMap };
  nodes: number;
  files: { total: number; bytes: number; by_status: CountMap; by_kind: CountMap };
  chunks: { total: number; by_status: CountMap };
  figures: { total: number; by_status: CountMap };
  jobs: { by_status: CountMap };
  turns: {
    total: number;
    last_7d: number;
    with_errors: number;
    by_route: CountMap;
  };
  tokens: {
    measured_turns: number;
    prompt: number;
    completion: number;
    total: number;
    cached: number;
    /** 어림 합계. 실측과 **나란히** 보여 주기 위한 값이지 대체재가 아니다. */
    estimate_total: number;
  };
  latency: { p50: number; p95: number };
}

/** 튜너블 하나의 위젯·설명 스펙. 서버가 소유한다(코드 기본값 옆에 있어야 안 어긋난다). */
export interface AdminSettingSpec {
  key: string;
  label: string;
  group: string;
  widget: "toggle" | "number" | "slider" | "select" | "json";
  /** live=다음 요청부터 / new-only=신규 처리분부터 / danger=재인덱싱 필요 */
  scope: "live" | "new-only" | "danger";
  description: string;
  effect: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string | number; label: string }[];
}

export interface AdminSettingItem {
  key: string;
  value: unknown;
  default: unknown;
  modified: boolean;
  /** app_settings에 행이 없다 — 조정 자체가 불가능한 상태(D62). */
  missing_row: boolean;
  updated_at: string | null;
  updated_by: string | null;
  spec: AdminSettingSpec;
}

export interface AdminSettingsView {
  groups: string[];
  items: AdminSettingItem[];
  /** 오버레이 캐시 TTL — "몇 초 안에 반영되는지"를 화면 문구에 그대로 쓴다. */
  ttl_seconds: number;
}

export interface FlowNode {
  id: string;
  label: string;
  kind: "io" | "guard" | "read" | "decision" | "logic" | "llm" | "skill" | "render" | "store";
  route: "both" | "react" | "legacy";
  where?: string;
  detail?: string;
  tunables?: string[];
  skills?: string[];
  params?: Record<string, unknown>;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  route?: "react" | "legacy";
}

export interface AdminFlow {
  active_route: "react" | "legacy";
  react_max_steps: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** 로그가 말하는 실제 경로 분포 — 설정과 어긋나면 여기서 드러난다. */
  observed_routes: CountMap;
}

export interface AdminSkillUsage {
  skill: string;
  calls: number;
  failures: number;
  skipped: number;
  turns: number;
  avg_ms: number | null;
  max_ms: number | null;
  last_used: string | null;
}

export interface AdminSkill {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 어느 (공간/역할/세션상태) 조합에서 노출되는지. 코드를 실제로 호출해 계산한다. */
  exposed_in: string[];
  usage: AdminSkillUsage | null;
}

export interface AdminSkillsResponse {
  days: number;
  skills: AdminSkill[];
}

export interface AdminConversation {
  session_id: string;
  title: string | null;
  space_kind: string;
  space_ref: string | null;
  class_name: string | null;
  owner_id: string;
  owner_email: string | null;
  owner_role: string | null;
  node_count: number;
  turn_count: number;
  token_total: number;
  error_turns: number;
  created_at: string;
  updated_at: string;
  last_activity: string;
}

export interface AdminConversationsResponse {
  total: number;
  limit: number;
  offset: number;
  conversations: AdminConversation[];
}

export interface AdminConversationNode {
  id: string;
  parent_id: string | null;
  question: string | null;
  answer: string | null;
  label: string | null;
  attachments: Record<string, unknown> | null;
  rag_sources: RagSource[] | null;
  created_at: string;
}

export interface AdminConversationDetail {
  session: {
    id: string;
    owner_id: string;
    space_kind: string;
    space_ref: string | null;
    title: string | null;
    emoji: string | null;
    created_at: string;
    updated_at: string;
  };
  owner: { id: string; email: string | null; role: string | null; display_name: string | null } | null;
  nodes: AdminConversationNode[];
  logs: AdminLog[];
}

export interface AdminDocument {
  file_id: string;
  name: string | null;
  kind: string;
  space_kind: string;
  space_ref: string | null;
  class_name: string | null;
  owner_id: string;
  owner_email: string | null;
  status: string;
  mime: string | null;
  size_bytes: number | null;
  /** 워커가 갱신하는 진행률. 실제 청크 행 수(chunks_rows)와 어긋날 수 있다. */
  chunk_total: number;
  chunk_done: number;
  context_chars: number | null;
  error: string | null;
  session_id: string | null;
  chunks_rows: number;
  chunks_embedded: number;
  chunks_stored: number;
  chunks_failed: number;
  chunk_chars: number;
  figures_total: number;
  figures_ok: number;
  created_at: string;
  updated_at: string;
}

export interface AdminDocumentsResponse {
  total: number;
  limit: number;
  offset: number;
  documents: AdminDocument[];
}

export interface AdminChunk {
  id: string;
  seq: number;
  status: string;
  chunk_text: string;
  created_at: string;
}

export interface AdminJob {
  id: string;
  kind: string;
  status: string;
  progress: number;
  attempts: number;
  error: string | null;
  batch_range: Record<string, unknown> | null;
  parent_job_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminDocumentDetail {
  file: Record<string, unknown> & {
    id: string;
    name: string | null;
    kind: string;
    status: string;
    chunk_total: number;
    chunk_done: number;
    error: string | null;
    size_bytes: number | null;
    mime: string | null;
    created_at: string;
    updated_at: string;
  };
  owner: { id: string; email: string | null; role: string | null } | null;
  chunks: AdminChunk[];
  chunk_offset: number;
  jobs: AdminJob[];
  figures: {
    id: string;
    seq: number;
    page: number | null;
    caption: string;
    figure_type: string;
    status: string;
    selected_index: number | null;
  }[];
  /** D129 지식 원자 — 청크별 예상 질문(atom_rag_enabled로 생성). 없으면 빈 배열. */
  atoms: {
    id: string;
    chunk_seq: number;
    question: string;
    status: string;
  }[];
}

export interface RagTestHit {
  file_id: string;
  name: string;
  chunk_id: string | null;
  seq: number | null;
  distance: number | null;
  score: number | null;
  /** 게이트 통과 여부. **차단된 것도 목록에 남는다** — 게이트 조정의 근거다. */
  passed: boolean;
  text: string;
}

export interface RagTestResult {
  query: string;
  top_k: number;
  max_distance: number;
  scope: { class_id: string | null; file_ids: string[]; file_count: number };
  embedding: { model: string; collection: string; ms?: number; dim?: number };
  search_ms?: number;
  hits: RagTestHit[];
  passed: number;
  blocked: number;
  /** 통과분만으로 만든, 실제로 주입될 블록 원문. */
  block: string;
  figures: { figure_id: string; caption: string; score: number; url?: string }[];
  notes: string[];
}

/**
 * D97 `/health/config` — 환경 자가진단.
 *
 * **비밀값은 담기지 않는다** — 존재 여부(bool)와 비밀이 아닌 URL·모델명만.
 */
export interface HealthConfig {
  ready: boolean;
  blocking: string[];
  environment: string;
  database: { app_dsn_set: boolean; worker_dsn_set: boolean; host: string | null; configured: boolean };
  auth: {
    jwt_algorithm: string;
    expire_minutes: number;
    /** 기본 시크릿이면 누구나 토큰을 위조할 수 있다 — 운영 전 반드시 교체. */
    secret_is_default: boolean;
    configured: boolean;
  };
  chat: { api_key_set: boolean; model: string; base_url: string; configured: boolean };
  upstage: {
    api_key_set: boolean;
    base_url: string;
    embedding_query_model: string;
    embedding_passage_model: string;
    configured: boolean;
  };
  qdrant: { url: string; configured: boolean };
  storage: { root: string; bucket: string };
  judge: {
    configured: boolean;
    missing: string[];
    base_url: string | null;
    model: string | null;
    pipeline_enabled: boolean;
    role: string;
    note: string;
  };
}

// ── D114: 백업 · 복원 · 초기화 ───────────────────────────────────────

export interface AdminBackup {
  name: string;
  created_at: string | null;
  created_by: string;
  note: string;
  scopes: string[];
  /** 테이블별 행 수. 무엇이 담겼는지 목록에서 바로 보인다. */
  counts: Record<string, number>;
  size_bytes: number;
}

export interface AdminBackupsResponse {
  backups: AdminBackup[];
  scopes: {
    all: string[];
    /** 복원 가능한 스코프. documents는 원본 바이트·벡터가 없어 빠져 있다. */
    restorable: string[];
    purgeable: string[];
  };
}

export interface AdminPurgeResult {
  scopes: string[];
  deleted: {
    conversations?: { ai_logs: number; nodes: number; sessions: number };
    documents?: { files: number; failed: string[] };
  };
  /** 지우기 전에 자동으로 뜬 백업(끄지 않았다면). */
  backup: AdminBackup | null;
}

export interface AdminRestoreResult {
  name: string;
  scopes: string[];
  restored: {
    conversations?: {
      sessions: number;
      nodes: number;
      ai_logs: number;
      heads_relinked: number;
      /** D152 — 캔버스가 곧 대화 내용이다(D122). 옛 백업에는 없어 optional. */
      canvas_items?: number;
      canvas_links?: number;
      canvas_drawings?: number;
    };
    settings?: { app_settings: number };
  };
}

export interface AdminClass {
  id: string;
  name: string | null;
  join_code: string | null;
  teacher_id: string | null;
  created_at: string;
}

/** D33: POST /teacher/classes 생성 응답(student_count 없음). */
export interface CreatedClass {
  id: string;
  name: string | null;
  join_code: string | null;
  teacher_id?: string | null;
  created_at: string;
}
