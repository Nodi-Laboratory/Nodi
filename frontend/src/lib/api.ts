import { createClient } from "@/lib/supabase/client";
import { assertRealId, isRealId } from "@/lib/ids";
import type {
  AdminLogDetail,
  AdminLogsResponse,
  AdminSetting,
  AdminTracesResponse,
  AdminUsage,
  AdminUser,
  ChatDoneEvent,
  ChatNavigatorEvent,
  ChatStartEvent,
  ChunkContext,
  ConnectionResponse,
  CooccurrenceRow,
  CreatedClass,
  FileGraphNode,
  FileLink,
  FileRow,
  FileSuggestion,
  HomeSuggestions,
  HomeSummary,
  NavigatorDefaults,
  OverseerDoneEvent,
  Profile,
  SessionDetail,
  SessionRow,
  SpaceKind,
  TagRow,
  TeacherClass,
  TeacherClassOverview,
  TeacherStudent,
  UserRole,
} from "@/lib/types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

/**
 * 08 G(D67): access_token 메모리 캐시. 모든 fetch가 호출당 `getSession()`을 await하던
 * 비용을 줄인다(보통 로컬 캐시지만 보장 없음). expires_at까지 재사용하되 만료 60초 전엔
 * getSession을 다시 불러 supabase가 갱신한 최신 토큰을 받는다(안전 마진).
 */
let tokenCache: { token: string; expiresAtMs: number } | null = null;

/**
 * 08 M1: access_token 캐시 무효화. 인증 상태가 바뀌면(로그아웃/로그인/토큰 갱신)
 * 반드시 호출해 캐시가 만료 전 옛 토큰을 들고 있는 것을 막는다(동작 불변 보장).
 * Providers의 supabase onAuthStateChange가 모든 이벤트에서 호출한다.
 */
export function clearTokenCache(): void {
  tokenCache = null;
}

async function getAccessToken(): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs - 60_000 > now) {
    return tokenCache.token;
  }
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) {
    tokenCache = {
      token: session.access_token,
      // expires_at은 unix 초. 없으면 보수적으로 1분만 캐시.
      expiresAtMs: session.expires_at
        ? session.expires_at * 1000
        : now + 60_000,
    };
    return session.access_token;
  }
  tokenCache = null;
  return null;
}

/** Supabase 세션의 access_token을 Authorization 헤더로. (키 하드코딩 없음) */
async function authHeaders(json = false): Promise<Record<string, string>> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/** HTTP 상태 코드를 보존하는 에러(503 등 분기용). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  return res;
}

export interface SpaceTarget {
  space_kind: SpaceKind;
  space_ref?: string | null;
}

/** 라우트의 spaceId → 백엔드 공간 매핑. 'personal' | <class uuid> */
export function spaceTargetFromId(spaceId: string): SpaceTarget {
  if (spaceId === "personal") return { space_kind: "personal" };
  return { space_kind: "class", space_ref: spaceId };
}

export async function listSessions(target: SpaceTarget): Promise<SessionRow[]> {
  const params = new URLSearchParams({ space_kind: target.space_kind });
  if (target.space_ref) params.set("space_ref", target.space_ref);
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions?${params.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

export async function createSession(
  target: SpaceTarget,
  title?: string,
): Promise<SessionRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({
        space_kind: target.space_kind,
        space_ref: target.space_ref ?? undefined,
        title,
      }),
    }),
  );
  return res.json();
}

/** 세션 이름 변경(D17). */
export async function patchSession(
  id: string,
  title: string,
): Promise<SessionRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${id}`, {
      method: "PATCH",
      headers: await authHeaders(true),
      body: JSON.stringify({ title }),
    }),
  );
  return res.json();
}

/** 세션 삭제(D17). 204. */
export async function deleteSession(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/sessions/${id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

/** D55b: 네비게이터 유효 기본값(config ⊕ admin override 합성). 비-admin도 읽기 가능. */
export async function getNavigatorDefaults(): Promise<NavigatorDefaults> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/auth/me/navigator-defaults`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

/** 온보딩 1회 완료 표시(D18). */
export async function completeOnboarding(): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/auth/complete-onboarding`, {
      method: "POST",
      headers: await authHeaders(),
    }),
  );
}

export async function getSession(id: string): Promise<SessionDetail> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${id}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

// ── 개념 태그 (Stage 2) ──────────────────────────────────────────────

function spaceParams(target: SpaceTarget): URLSearchParams {
  const params = new URLSearchParams({ space_kind: target.space_kind });
  if (target.space_ref) params.set("space_ref", target.space_ref);
  return params;
}

export async function listTags(target: SpaceTarget): Promise<TagRow[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/tags?${spaceParams(target).toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

export async function listCooccurrence(
  target: SpaceTarget,
): Promise<CooccurrenceRow[]> {
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/tags/cooccurrence?${spaceParams(target).toString()}`,
      { headers: await authHeaders() },
    ),
  );
  return res.json();
}

/** 네비게이터(is_navigator) 노드 삭제. 204 반환. */
export async function deleteNode(id: string): Promise<void> {
  assertRealId(id, "node_id"); // D63: 임시 노드 id는 DB 경계로 못 보냄
  await ensureOk(
    await fetch(`${API_BASE}/nodes/${id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

// ── 파일 / RAG (Stage 3b) ────────────────────────────────────────────

/** 멀티파트 업로드. service_role 미설정 시 백엔드 503. (Content-Type 미지정 — FormData가 boundary 설정) */
export async function uploadFile(
  target: SpaceTarget,
  file: File,
  opts?: {
    sessionId?: string | null;
    positionX?: number;
    positionY?: number;
    kind?: string;
  },
): Promise<FileRow> {
  const form = new FormData();
  form.append("file", file);
  form.append("space_kind", target.space_kind);
  if (target.space_ref) form.append("space_ref", target.space_ref);
  if (opts?.kind) form.append("kind", opts.kind);
  if (opts?.sessionId) form.append("session_id", opts.sessionId);
  if (opts?.positionX != null) form.append("position_x", String(Math.round(opts.positionX)));
  if (opts?.positionY != null) form.append("position_y", String(Math.round(opts.positionY)));
  const res = await ensureOk(
    await fetch(`${API_BASE}/files`, {
      method: "POST",
      headers: await authHeaders(), // json=false → Content-Type 없음
      body: form,
    }),
  );
  return res.json();
}

/** 파일 노드 좌표 영속(D20). */
export async function patchFilePosition(
  fileId: string,
  x: number,
  y: number,
): Promise<FileRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/${fileId}/position`, {
      method: "PATCH",
      headers: await authHeaders(true),
      body: JSON.stringify({
        position_x: Math.round(x),
        position_y: Math.round(y),
      }),
    }),
  );
  return res.json();
}

export async function listFiles(target: SpaceTarget): Promise<FileRow[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files?${spaceParams(target).toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

// ── 교사 컨트롤 패널 (Stage 4b, teacher role만) ──────────────────────

export async function listTeacherClasses(): Promise<TeacherClass[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes`, { headers: await authHeaders() }),
  );
  return res.json();
}

/** D67: 교사 콘솔 홈 — 학급별 학생수·자료수·최근활동(last_activity_at desc nulls last). */
export async function fetchTeacherOverview(): Promise<TeacherClassOverview[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes/overview`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

/** D33: 교사가 학급 생성. 성공 시 새 학급 row(id·name·join_code 등). */
export async function createClass(name: string): Promise<CreatedClass> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ name }),
    }),
  );
  return res.json();
}

export async function listClassStudents(
  classId: string,
): Promise<TeacherStudent[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes/${classId}/students`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

export async function listStudentClassSessions(
  classId: string,
  userId: string,
): Promise<SessionRow[]> {
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/teacher/classes/${classId}/students/${userId}/sessions`,
      { headers: await authHeaders() },
    ),
  );
  return res.json();
}

export async function listClassMaterials(classId: string): Promise<FileRow[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes/${classId}/materials`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

export async function getFile(id: string): Promise<FileRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/${id}`, { headers: await authHeaders() }),
  );
  return res.json();
}

/** 파일 태그 목록(3b-3). indexed 파일이면 이름 배열. */
export async function getFileTags(id: string): Promise<string[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/${id}/tags`, { headers: await authHeaders() }),
  );
  const body = await res.json();
  return (body?.tags as string[]) ?? [];
}

/** 파일 삭제(3b-3). 204. service_role 미설정 시 503. */
export async function deleteFile(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/files/${id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

/** 파일 재처리(3b-3). failed/partial/멈춘 파일. */
export async function retryFile(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/files/${id}/retry`, {
      method: "POST",
      headers: await authHeaders(),
    }),
  );
}

/** 현재 분기에 연결 파일이 없을 때 제안(3b-3). */
export async function getFileSuggestions(
  sessionId: string,
  nodeId: string,
): Promise<FileSuggestion[]> {
  const params = new URLSearchParams({ node_id: nodeId });
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/sessions/${sessionId}/file-suggestions?${params.toString()}`,
      { headers: await authHeaders() },
    ),
  );
  const body = await res.json();
  return (body?.suggestions as FileSuggestion[]) ?? [];
}

/** 파일을 분기(노드)에 연결 = "이 자료 보고 답해줘"(시각적 RAG, 멱등). */
export async function addFileLink(
  fileId: string,
  targetNodeId: string,
): Promise<unknown> {
  assertRealId(fileId, "file_id"); // D63
  assertRealId(targetNodeId, "target_node_id");
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/${fileId}/links`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ target_node_id: targetNodeId }),
    }),
  );
  return res.json().catch(() => null);
}

export async function removeFileLink(
  fileId: string,
  nodeId: string,
): Promise<void> {
  assertRealId(fileId, "file_id"); // D63
  assertRealId(nodeId, "node_id");
  await ensureOk(
    await fetch(`${API_BASE}/files/${fileId}/links/${nodeId}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

/**
 * D41: RAG 출처 청크의 전문 + 인접 청크(prev/next) + 위치를 조회.
 * 접근 불가/없음이면 404 → ApiError(404).
 */
export async function getChunkContext(
  chunkId: string,
  neighbors = 1,
): Promise<ChunkContext> {
  const params = new URLSearchParams({ neighbors: String(neighbors) });
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/files/chunks/${encodeURIComponent(chunkId)}/context?${params.toString()}`,
      { headers: await authHeaders() },
    ),
  );
  return res.json();
}

export async function listSessionFileLinks(
  sessionId: string,
): Promise<FileLink[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file-links`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

// ── D58/D59: 자료 그래프 배치(placement) ─────────────────────────────
// 표시 소스. files.session_id 필터를 대체한다(owner-only, user-JWT).

/** 현재 세션 그래프에 배치된 자료 노드 목록(files 메타 조인). */
export async function listFileGraphNodes(
  sessionId: string,
): Promise<FileGraphNode[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file-graph-nodes`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

/** 자료를 그래프에 배치(POST). file_id+session_id 멱등 upsert. 좌표 null이면 서버 기본. */
export async function addFileGraphNode(
  sessionId: string,
  fileId: string,
  x: number | null,
  y: number | null,
): Promise<FileGraphNode> {
  assertRealId(sessionId, "session_id"); // D63
  assertRealId(fileId, "file_id");
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file-graph-nodes`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({
        file_id: fileId,
        position_x: x == null ? null : Math.round(x),
        position_y: y == null ? null : Math.round(y),
      }),
    }),
  );
  return res.json();
}

/** 배치 좌표 갱신(PATCH, 드래그 이동). */
export async function patchFileGraphNode(
  sessionId: string,
  fileId: string,
  x: number,
  y: number,
): Promise<FileGraphNode> {
  assertRealId(sessionId, "session_id"); // D63
  assertRealId(fileId, "file_id");
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file-graph-nodes`, {
      method: "PATCH",
      headers: await authHeaders(true),
      body: JSON.stringify({
        file_id: fileId,
        position_x: Math.round(x),
        position_y: Math.round(y),
      }),
    }),
  );
  return res.json();
}

/** 그래프에서 자료 제거(DELETE). 파일·RAG링크는 유지. */
export async function removeFileGraphNode(
  sessionId: string,
  fileId: string,
): Promise<void> {
  assertRealId(sessionId, "session_id"); // D63
  assertRealId(fileId, "file_id");
  await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file-graph-nodes/${fileId}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

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

// ── SSE 스트리밍 채팅 ────────────────────────────────────────────────
// EventSource는 Authorization 헤더를 못 실으므로 fetch + ReadableStream 파싱.

export interface ChatNavigatorOverride {
  enabled?: boolean;
  count?: number;
  gate_k?: number;
  period?: number;
}

export interface ChatStreamBody {
  session_id: string;
  question: string;
  parent_node_id?: string | null;
  /** Wave A(D15): 브랜치 참조 — 이 턴만 참조할 노드들(일회성, 비영속). */
  reference_node_ids?: string[];
  /** D47: 네비게이터 자동생성 per-request override(서버가 안전범위로 clamp). */
  navigator?: ChatNavigatorOverride | null;
  /**
   * 09: /retrieve의 near 좌표 릴레이 — 서버가 첫 개념(index 0)을 이 셀에 배치.
   * null이면 서버가 자체 폴백 앵커로 계산.
   */
  place_hint?: { x: number; y: number } | null;
}

/**
 * 노드 좌표 일괄 영속(D20). 드래그 종료/재정렬 시 저장.
 *
 * 08 C(D69): 노드마다 1 RT(서버 for-루프)였던 set_node_positions를 단일 RPC
 * `set_node_positions_bulk`(0026) 1회 호출로 교체한다(N RT→1). RPC는 SECURITY INVOKER라
 * 호출자 JWT + nodes RLS로 owner 본인 노드만 갱신하며, PostgREST rpc 패턴
 * (예: join_class_by_code)을 따라 supabase 클라이언트로 직접 호출한다.
 *
 * D52/D63: 영속 직전 비-UUID id(provisional:/optimistic: 등)를 isRealId로 1차 필터한다
 * (RPC도 캐스트 전 필터하지만 이중 방어). 남은 게 없으면 호출 자체를 생략.
 */
export async function putNodePositions(
  sessionId: string,
  positions: { node_id: string; x: number; y: number }[],
): Promise<void> {
  if (!isRealId(sessionId)) return;
  const valid = positions.filter((p) => isRealId(p.node_id));
  if (valid.length === 0) return;
  const supabase = createClient();
  const { error } = await supabase.rpc("set_node_positions_bulk", {
    p_session_id: sessionId,
    p_positions: valid.map((p) => ({
      node_id: p.node_id,
      x: Math.round(p.x),
      y: Math.round(p.y),
    })),
  });
  if (error) {
    throw new ApiError(500, error.message ?? "좌표 저장에 실패했습니다.");
  }
}

/** 09: place SSE 이벤트 페이로드. */
export interface PlaceEvent {
  concept_index: number;
  x: number;
  y: number;
}

export interface ChatStreamHandlers {
  onStart?: (data: ChatStartEvent) => void;
  onToken?: (delta: string) => void;
  onDone?: (data: ChatDoneEvent) => void;
  onNavigator?: (data: ChatNavigatorEvent) => void;
  onError?: (detail: string) => void;
  /** 09: 서버가 개념 배치 좌표를 확정할 때마다 전송하는 place 이벤트. */
  onPlace?: (data: PlaceEvent) => void;
}

interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

function parseFrame(frame: string): SSEEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return null; // non-JSON keepalive
  }
  const type = eventName !== "message" ? eventName : (data.type as string);
  if (!type) return null;
  return { type, data };
}

/** 공통 SSE 소비기: POST 후 ReadableStream을 프레임 단위로 onEvent에 전달. */
async function consumeSSE(
  path: string,
  body: unknown,
  onEvent: (ev: SSEEvent) => void,
  onError: (detail: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    onError("서버에 연결할 수 없습니다.");
    return;
  }

  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      detail = (await res.json())?.detail ?? detail;
    } catch {
      /* ignore */
    }
    onError(detail);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep).replace(/\r/g, "");
        buffer = buffer.slice(sep + 2);
        if (frame.trim()) {
          const ev = parseFrame(frame);
          if (ev) onEvent(ev);
        }
      }
    }
    if (buffer.trim()) {
      const ev = parseFrame(buffer.replace(/\r/g, ""));
      if (ev) onEvent(ev);
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      onError("스트리밍이 중단되었습니다.");
    }
  }
}

export async function streamChat(
  body: ChatStreamBody,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await consumeSSE(
    "/chat/stream",
    body,
    (ev) => {
      switch (ev.type) {
        case "start":
          handlers.onStart?.(ev.data as unknown as ChatStartEvent);
          break;
        case "token":
          handlers.onToken?.((ev.data.delta as string) ?? "");
          break;
        case "done":
          handlers.onDone?.(ev.data as unknown as ChatDoneEvent);
          break;
        case "navigator":
          handlers.onNavigator?.(ev.data as unknown as ChatNavigatorEvent);
          break;
        case "place":
          // 09: 서버 좌표 확정 이벤트 — concept_index별 x/y 전달
          handlers.onPlace?.(ev.data as unknown as PlaceEvent);
          break;
        case "error":
          handlers.onError?.((ev.data.detail as string) ?? "스트리밍 오류");
          break;
      }
    },
    (d) => handlers.onError?.(d),
    signal,
  );
}

// ── SVG 삽화 검색 (Claude 사전생성 라이브러리 · pgvector) ──────────────

export interface ArtHit {
  slug: string;
  url: string;
  title: string | null;
  tags: string[] | null;
  distance: number;
}

export interface ArtSearchResult {
  /** 임계값 이내 매치가 있으면 삽화, 없으면 null. */
  art: ArtHit | null;
  /** 질의 임베딩(768d) — 개념 유사도 그룹핑에 재사용(호출 1회로 삽화+그룹핑). */
  embedding: number[] | null;
}

/** 개념 제목으로 유사 SVG를 검색한다. 실패/무매치 시 art=null. */
export async function searchArt(
  q: string,
  k = 1,
): Promise<ArtSearchResult> {
  const query = q.trim();
  if (!query) return { art: null, embedding: null };
  const params = new URLSearchParams({ q: query, k: String(k) });
  try {
    const res = await fetch(`${API_BASE}/art/search?${params.toString()}`, {
      headers: await authHeaders(),
    });
    if (!res.ok) return { art: null, embedding: null };
    return (await res.json()) as ArtSearchResult;
  } catch {
    return { art: null, embedding: null };
  }
}

// ── 임베딩 검색 + 캔버스 영속 (Upstage /retrieve · PATCH /nodes, C4/C5) ──

export interface RetrieveEbsHit {
  videoId: string;
  title: string;
  thumb: string;
  score: number;
}

export interface RetrieveArtHit {
  slug: string;
  url: string;
  title: string;
  score: number;
}

export interface RetrieveResult {
  /**
   * 09: 서버가 계산한 캔버스 배치 좌표 — 항상 존재(degraded여도 폴백 좌표).
   * retrieve 자체가 reject/타임아웃이면 프론트 로컬 폴백(아래 degradedRetrieve).
   */
  near: { x: number; y: number; score: number | null };
  ebs: RetrieveEbsHit[];
  art: RetrieveArtHit[];
  /** 백엔드 임베딩/Qdrant 실패 — near는 폴백 좌표로 채워진 채 반환됨(09 계약). */
  degraded: boolean;
}

const RETRIEVE_TIMEOUT_MS = 4000;

/** retrieve 자체가 네트워크 실패/타임아웃일 때 — near 좌표는 호출부가 로컬 폴백 계산. */
function degradedRetrieve(): RetrieveResult {
  return { near: { x: 0, y: 0, score: null }, ebs: [], art: [], degraded: true };
}

/**
 * POST /retrieve (09) — 서버 좌표(near) + EBS/삽화 추천. SSE 선행 호출이므로
 * 절대 reject하지 않고, 타임아웃(4s)·오류 모두 degraded(near={0,0})로 resolve한다.
 * session_id 추가 필수 — 서버가 같은 세션 카드와 kNN 유사도로 좌표를 계산함.
 */
export async function retrieve(
  question: string,
  sessionId: string,
): Promise<RetrieveResult> {
  const q = question.trim();
  if (!q) return degradedRetrieve();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RETRIEVE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/retrieve`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ question: q.slice(0, 2000), session_id: sessionId }),
      signal: controller.signal,
    });
    if (!res.ok) return degradedRetrieve();
    const body = (await res.json()) as {
      near?: { x?: number; y?: number; score?: number | null } | null;
      ebs?: Array<{ video_id?: string; title?: string; thumb?: string; score?: number }>;
      art?: Array<{ slug?: string; url?: string; title?: string; score?: number }>;
      degraded?: boolean;
    };
    return {
      // near는 서버가 항상 채움 — 없으면 폴백(0,0)으로 안전 처리
      near: {
        x: typeof body?.near?.x === "number" ? body.near.x : 0,
        y: typeof body?.near?.y === "number" ? body.near.y : 0,
        score: body?.near?.score ?? null,
      },
      ebs: (body?.ebs ?? [])
        .filter((e) => e?.video_id)
        .map((e) => ({
          videoId: String(e.video_id),
          title: e.title ?? "",
          thumb: e.thumb ?? `https://i.ytimg.com/vi/${e.video_id}/hqdefault.jpg`,
          score: e.score ?? 0,
        })),
      art: (body?.art ?? [])
        .filter((a) => a?.slug)
        .map((a) => ({
          slug: String(a.slug),
          url: a.url ?? `/art/${a.slug}.svg`,
          title: a.title ?? "",
          score: a.score ?? 0,
        })),
      degraded: !!body?.degraded,
    };
  } catch {
    return degradedRetrieve();
  } finally {
    clearTimeout(timer);
  }
}

/** C5/09: nodes.attachments.canvas에 병합 저장되는 형태(ebs/art — snake_case). */
export interface NodeCanvasAttachment {
  ebs: Array<{ video_id: string; title: string; thumb: string; score: number }>;
  art: Array<{ slug: string; url: string; title: string; score: number }>;
}

/**
 * PATCH /nodes/{id} (C5) — retrieve 결과(ebs/art) 영속.
 * 09: 좌표 저장은 서버 done 훅이 담당 → positionX/Y 전달 제거.
 * done 이후 fire-and-forget: 실패는 삼킨다(캔버스는 replay만으로도 재구성 가능).
 */
export async function patchNodeCanvas(
  nodeId: string,
  patch: {
    attachmentsCanvas?: NodeCanvasAttachment | null;
  },
): Promise<void> {
  if (!isRealId(nodeId)) return; // D63: 임시 id는 DB 경계로 못 보냄
  try {
    await fetch(`${API_BASE}/nodes/${nodeId}`, {
      method: "PATCH",
      headers: await authHeaders(true),
      body: JSON.stringify({
        attachments_canvas: patch.attachmentsCanvas ?? null,
      }),
    });
  } catch {
    /* best-effort */
  }
}

// ── 홈 + 총괄 AI (Stage 4a) ──────────────────────────────────────────

export async function getHomeSummary(
  recentLimit = 8,
  conceptLimit = 8,
): Promise<HomeSummary> {
  const params = new URLSearchParams({
    recent_limit: String(recentLimit),
    concept_limit: String(conceptLimit),
  });
  const res = await ensureOk(
    await fetch(`${API_BASE}/home/summary?${params.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

export async function getHomeSuggestions(count = 3): Promise<HomeSuggestions> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/home/suggestions?count=${count}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

export interface OverseerStreamHandlers {
  onToken?: (delta: string) => void;
  onDone?: (data: OverseerDoneEvent) => void;
  onError?: (detail: string) => void;
}

export async function streamOverseer(
  message: string,
  handlers: OverseerStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await consumeSSE(
    "/overseer/stream",
    { message },
    (ev) => {
      switch (ev.type) {
        case "token":
          handlers.onToken?.((ev.data.delta as string) ?? "");
          break;
        case "done":
          handlers.onDone?.(ev.data as unknown as OverseerDoneEvent);
          break;
        case "error":
          handlers.onError?.((ev.data.detail as string) ?? "스트리밍 오류");
          break;
      }
    },
    (d) => handlers.onError?.(d),
    signal,
  );
}

// ── 관리자 (Stage 4c, 관리자만) ──────────────────────────────────────

export async function listAdminUsers(): Promise<AdminUser[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/users`, { headers: await authHeaders() }),
  );
  return res.json();
}

export async function setUserRole(
  userId: string,
  role: UserRole,
): Promise<Profile> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/users/${userId}/role`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ role }),
    }),
  );
  return res.json();
}

export async function listAdminSettings(): Promise<AdminSetting[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/settings`, { headers: await authHeaders() }),
  );
  return res.json();
}

export async function putAdminSetting(
  key: string,
  value: unknown,
): Promise<AdminSetting> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: await authHeaders(true),
      body: JSON.stringify({ value }),
    }),
  );
  return res.json();
}

export async function getAdminUsage(): Promise<AdminUsage> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/usage`, { headers: await authHeaders() }),
  );
  return res.json();
}

export async function getAdminLogs(opts: {
  userId?: string | null;
  since?: string | null;
  until?: string | null;
  limit?: number;
  offset?: number;
}): Promise<AdminLogsResponse> {
  const params = new URLSearchParams();
  if (opts.userId) params.set("user_id", opts.userId);
  if (opts.since) params.set("since", opts.since);
  if (opts.until) params.set("until", opts.until);
  params.set("limit", String(opts.limit ?? 20));
  params.set("offset", String(opts.offset ?? 0));
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/logs?${params.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

/** D34: 턴 상세 — ai_logs 1행(구조화 contexts) + 같은 세션 ReAct 트레이스. */
export async function getAdminLogDetail(logId: string): Promise<AdminLogDetail> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/logs/${encodeURIComponent(logId)}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

/** D34: ReAct 트레이스 목록(user/session 필터). 턴 상세는 보통 getAdminLogDetail로 충분. */
export async function getAdminTraces(opts: {
  userId?: string | null;
  sessionId?: string | null;
  limit?: number;
  offset?: number;
}): Promise<AdminTracesResponse> {
  const params = new URLSearchParams();
  if (opts.userId) params.set("user_id", opts.userId);
  if (opts.sessionId) params.set("session_id", opts.sessionId);
  params.set("limit", String(opts.limit ?? 20));
  params.set("offset", String(opts.offset ?? 0));
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/traces?${params.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}
