import { createClient } from "@/lib/supabase/client";
import type {
  ChatDoneEvent,
  ChatNavigatorEvent,
  ChatStartEvent,
  ConnectionResponse,
  CooccurrenceRow,
  SessionDetail,
  SessionRow,
  SpaceKind,
  TagRow,
} from "@/lib/types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

/** Supabase 세션의 access_token을 Authorization 헤더로. (키 하드코딩 없음) */
async function authHeaders(json = false): Promise<Record<string, string>> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers: Record<string, string> = {};
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  if (json) headers["Content-Type"] = "application/json";
  return headers;
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
    throw new Error(detail);
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
  await ensureOk(
    await fetch(`${API_BASE}/nodes/${id}`, {
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
}

export interface ChatStreamHandlers {
  onStart?: (data: ChatStartEvent) => void;
  onToken?: (delta: string) => void;
  onDone?: (data: ChatDoneEvent) => void;
  onNavigator?: (data: ChatNavigatorEvent) => void;
  onError?: (detail: string) => void;
}

function dispatchFrame(frame: string, handlers: ChatStreamHandlers) {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return;

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    /* non-JSON keepalive: ignore */
    return;
  }

  const type = eventName !== "message" ? eventName : (data.type as string);
  switch (type) {
    case "start":
      handlers.onStart?.(data as unknown as ChatStartEvent);
      break;
    case "token":
      handlers.onToken?.((data.delta as string) ?? "");
      break;
    case "done":
      handlers.onDone?.(data as unknown as ChatDoneEvent);
      break;
    case "navigator":
      handlers.onNavigator?.(data as unknown as ChatNavigatorEvent);
      break;
    case "error":
      handlers.onError?.((data.detail as string) ?? "스트리밍 오류");
      break;
    default:
      break;
  }
}

export async function streamChat(
  body: ChatStreamBody,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/chat/stream`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    handlers.onError?.("서버에 연결할 수 없습니다.");
    return;
  }

  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      detail = (await res.json())?.detail ?? detail;
    } catch {
      /* ignore */
    }
    handlers.onError?.(detail);
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
      // SSE 프레임은 빈 줄(\n\n)로 구분
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep).replace(/\r/g, "");
        buffer = buffer.slice(sep + 2);
        if (frame.trim()) dispatchFrame(frame, handlers);
      }
    }
    if (buffer.trim()) dispatchFrame(buffer.replace(/\r/g, ""), handlers);
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      handlers.onError?.("스트리밍이 중단되었습니다.");
    }
  }
}
