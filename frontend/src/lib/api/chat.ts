/** SSE 스트리밍 채팅. api.ts(806줄)에서 분리 — D102. */
import { API_BASE, authHeaders } from "./_core";
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
  /**
   * 학생이 지금 고른 트리(태그) — D151.
   *
   * 컨텍스트를 **자르는 값이 아니다.** 서버는 모든 카드를 태그별 트리 순서로
   * 다 넣고, 이 값으로 "지금 여기를 보고 있다"만 알린다(사용자 결정:
   * "모든 컨텍스트를 다 붙여도 돼. 대신 AI가 그걸 판단할 수 있도록").
   */
  focus_tag?: string | null;
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

export interface ChatStreamHandlers {
  onStart?: (data: ChatStartEvent) => void;
  onToken?: (delta: string) => void;
  onDone?: (data: ChatDoneEvent) => void;
  /**
   * `status`는 HTTP 상태다(SSE 안에서 난 오류면 없다). 404는 **세션이
   * 사라졌다**는 뜻이라 호출부가 다르게 다뤄야 한다 — 관리자가 데이터를
   * 초기화했거나 다른 탭에서 세션을 지운 경우다.
   */
  onError?: (detail: string, status?: number) => void;
  /**
   * D109: ReAct가 도구를 부르기 시작했다. 첫 토큰까지 시간이 걸리는 구간이라
   * 빈 화면 대신 "수업 자료를 찾고 있어요" 같은 진행 표시를 띄우는 신호다.
   */
  onToolCall?: (name: string) => void;
  /** 도구가 끝났다. 실패해도 `ok: false`로 오고 턴은 계속된다. */
  onToolResult?: (name: string, ok: boolean, message: string) => void;
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
  onError: (detail: string, status?: number) => void,
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
    onError(detail, res.status);
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
        case "tool_call":
          handlers.onToolCall?.((ev.data.name as string) ?? "");
          break;
        case "tool_result":
          handlers.onToolResult?.(
            (ev.data.name as string) ?? "",
            Boolean(ev.data.ok),
            (ev.data.message as string) ?? "",
          );
          break;
        case "done":
          handlers.onDone?.(ev.data as unknown as ChatDoneEvent);
          break;
        case "error":
          handlers.onError?.((ev.data.detail as string) ?? "스트리밍 오류");
          break;
      }
    },
    (d, status) => handlers.onError?.(d, status),
    signal,
  );
}



