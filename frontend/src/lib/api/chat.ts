/** SSE 스트리밍 채팅. api.ts(806줄)에서 분리 — D102. */
import { API_BASE, authHeaders, ApiError } from "./_core";
import { createClient } from "@/lib/supabase/client";
import { isRealId } from "@/lib/ids";
import type {
  ChatDoneEvent,
  ChatStartEvent,
} from "@/lib/types";

// ── SSE 스트리밍 채팅 ────────────────────────────────────────────────
// EventSource는 Authorization 헤더를 못 실으므로 fetch + ReadableStream 파싱.

export interface ChatStreamBody {
  session_id: string;
  question: string;
  parent_node_id?: string | null;
  /** Wave A(D15): 브랜치 참조 — 이 턴만 참조할 노드들(일회성, 비영속). */
  reference_node_ids?: string[];
  /**
   * 09 단일 writer: retrieve 결과(figures)를 서버에 전달해 done 훅이 한 번의
   * PATCH로 attachments.canvas에 저장. null이면 저장 생략(degraded 등).
   * D94: ebs/art 제거.
   */
  retrieved?: {
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

