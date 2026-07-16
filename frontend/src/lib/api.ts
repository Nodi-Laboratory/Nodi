import { createClient } from "@/lib/supabase/client";
import { assertRealId, isRealId } from "@/lib/ids";
import type {
  AdminLogDetail,
  AdminLogsResponse,
  AdminSetting,
  AdminUser,
  ChatDoneEvent,
  ChatStartEvent,
  ChunkContext,
  ConnectionResponse,
  CreatedClass,
  FileRow,
  HomeSummary,
  Profile,
  SessionDetail,
  SessionRow,
  SpaceKind,
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

// 공간 쿼리 파라미터 헬퍼(listFiles 등 공용).
function spaceParams(target: SpaceTarget): URLSearchParams {
  const params = new URLSearchParams({ space_kind: target.space_kind });
  if (target.space_ref) params.set("space_ref", target.space_ref);
  return params;
}

// ── 파일 / RAG (Stage 3b) ────────────────────────────────────────────

/** 멀티파트 업로드. service_role 미설정 시 백엔드 503. (Content-Type 미지정 — FormData가 boundary 설정) */
export async function uploadFile(
  target: SpaceTarget,
  file: File,
  opts?: {
    kind?: string;
    /** D83: 세션 컨텍스트로 연결(user_upload 전용). */
    session_id?: string;
  },
): Promise<FileRow> {
  const form = new FormData();
  form.append("file", file);
  form.append("space_kind", target.space_kind);
  if (target.space_ref) form.append("space_ref", target.space_ref);
  if (opts?.kind) form.append("kind", opts.kind);
  if (opts?.session_id) form.append("session_id", opts.session_id);
  const res = await ensureOk(
    await fetch(`${API_BASE}/files`, {
      method: "POST",
      headers: await authHeaders(), // json=false → Content-Type 없음
      body: form,
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

/** D83: 세션 컨텍스트 파일 목록(업로드 순 — 주입 순서와 동일). */
export async function listSessionFiles(sessionId: string): Promise<FileRow[]> {
  const params = new URLSearchParams({ session_id: sessionId });
  const res = await ensureOk(
    await fetch(`${API_BASE}/files?${params.toString()}`, {
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

export interface ChatStreamBody {
  session_id: string;
  question: string;
  parent_node_id?: string | null;
  /** Wave A(D15): 브랜치 참조 — 이 턴만 참조할 노드들(일회성, 비영속). */
  reference_node_ids?: string[];
  /**
   * 09 단일 writer: retrieve 결과(ebs/art/figures)를 서버에 전달해 done 훅이
   * concepts + ebs/art/figures를 한 번의 PATCH로 attachments.canvas에 통합 저장.
   * null이면 저장 생략(degraded 등).
   */
  retrieved?: {
    ebs: Array<{ video_id: string; title: string; thumb: string; score: number }>;
    art: Array<{ slug: string; url: string; title: string; score: number }>;
    // D87: figure는 url 제외(signed·만료). 서버가 재수화 시 getFigure로 재발급.
    figures?: Array<{
      figure_id: string;
      file_id: string;
      page?: number;
      caption: string;
      score: number;
    }>;
  } | null;
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

export interface ChatStreamHandlers {
  onStart?: (data: ChatStartEvent) => void;
  onToken?: (delta: string) => void;
  onDone?: (data: ChatDoneEvent) => void;
  onError?: (detail: string) => void;
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
      // detail은 문자열이 아닐 수 있다(예: 422의 Pydantic 오류 배열
      // [{type,loc,msg,input}]). 그대로 onError→렌더로 넘기면 React가
      // 객체를 자식으로 렌더하려다 크래시하므로 문자열로 정규화한다.
      const d = (await res.json())?.detail;
      if (typeof d === "string") detail = d;
      else if (d != null) detail = JSON.stringify(d);
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
  /** 질의 임베딩(4096d) — 개념 유사도 그룹핑에 재사용(호출 1회로 삽화+그룹핑). */
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

/** D87: 교과서 figure 히트. url은 signed(만료 有) — 라이브 배치엔 쓰되 서버로는
 *  전달하지 않고(ChatStreamBody figures는 url 제외), 재수화 시 getFigure로 재발급. */
export interface RetrieveFigureHit {
  figureId: string;
  fileId: string;
  page?: number;
  caption: string;
  url: string;
  score: number;
}

export interface RetrieveResult {
  ebs: RetrieveEbsHit[];
  art: RetrieveArtHit[];
  figures: RetrieveFigureHit[];
  /** 백엔드 임베딩/Qdrant 실패 — 프론트는 여전히 로컬 폴백으로 배치(09 계약). */
  degraded: boolean;
}

const RETRIEVE_TIMEOUT_MS = 4000;

/** retrieve 자체가 네트워크 실패/타임아웃일 때 — 좌표는 프론트 sim이 배치. */
function degradedRetrieve(): RetrieveResult {
  return { ebs: [], art: [], figures: [], degraded: true };
}

/**
 * POST /retrieve (09) — EBS/삽화 추천. SSE 선행 호출이므로 절대 reject하지 않고,
 * 타임아웃(4s)·오류 모두 degraded로 resolve한다. session_id는 서버 kNN 계산용
 * (좌표는 프론트 d3-force가 소유하므로 near는 무시).
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
      ebs?: Array<{ video_id?: string; title?: string; thumb?: string; score?: number }>;
      art?: Array<{ slug?: string; url?: string; title?: string; score?: number }>;
      figures?: Array<{
        figure_id?: string;
        file_id?: string;
        page?: number;
        caption?: string;
        url?: string;
        score?: number;
      }>;
      degraded?: boolean;
    };
    return {
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
      // D87: ebs/art와 동형(방어적: figure_id/url 없으면 drop, snake→camel).
      figures: (body?.figures ?? [])
        .filter((f) => f?.figure_id && f?.url)
        .map((f) => ({
          figureId: String(f.figure_id),
          fileId: String(f.file_id ?? ""),
          page: typeof f.page === "number" ? f.page : undefined,
          caption: f.caption ?? "",
          url: String(f.url),
          score: f.score ?? 0,
        })),
      degraded: !!body?.degraded,
    };
  } catch {
    return degradedRetrieve();
  } finally {
    clearTimeout(timer);
  }
}

/** C5/09: nodes.attachments.canvas에 병합 저장되는 형태(ebs/art/figures — snake_case).
 *  D87: figures는 url 제외 영속 — 재수화 시 getFigure로 fresh signed URL 재발급. */
export interface NodeCanvasAttachment {
  ebs: Array<{ video_id: string; title: string; thumb: string; score: number }>;
  art: Array<{ slug: string; url: string; title: string; score: number }>;
  figures?: Array<{
    figure_id: string;
    file_id: string;
    page?: number;
    caption: string;
    score: number;
  }>;
}

/**
 * D87: GET /files/figures/{id} — figure의 fresh signed URL 재발급 창구.
 * 재수화(url 비영속) + 만료 시 FigureNode onError가 1회 호출한다. camel 정규화.
 * 실패 시 throw(ApiError) — 호출부가 best-effort로 처리.
 */
export async function getFigure(
  figureId: string,
): Promise<{ figureId: string; url: string; caption: string; page?: number }> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/figures/${encodeURIComponent(figureId)}`, {
      headers: await authHeaders(),
    }),
  );
  const body = (await res.json()) as {
    figure_id?: string;
    url?: string;
    caption?: string;
    page?: number;
  };
  return {
    figureId: String(body.figure_id ?? figureId),
    url: body.url ?? "",
    caption: body.caption ?? "",
    page: typeof body.page === "number" ? body.page : undefined,
  };
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

/** D34: 턴 상세 — ai_logs 1행(구조화 contexts). */
export async function getAdminLogDetail(logId: string): Promise<AdminLogDetail> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/logs/${encodeURIComponent(logId)}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}
