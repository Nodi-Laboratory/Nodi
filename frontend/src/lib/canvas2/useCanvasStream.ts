"use client";

/**
 * 채팅 스트림 → 캔버스 아이템 (D125/D126).
 *
 * `useConceptStream.ts`(569줄)를 대체한다. 크게 줄어든 이유는 좌표·재수화·
 * 리프 배치가 전부 다른 모듈로 갔기 때문이다:
 *
 *   좌표      layout.ts / useItemLayout
 *   저장·편집 useCanvasItems
 *   재수화    react-query + GET /canvas
 *   여기      SSE 수신 → 파싱 → 아이템 누적 → 완료 시 일괄 저장
 *
 * ## pending 아이템도 처음부터 배치에 참여시킨다
 *
 * v1은 pending 카드를 시뮬레이션 밖(CENTER 고정)에 뒀다가 첫 `@concept:`에서
 * 편입시켰다. 그 순간 좌표가 CENTER → 태그 앵커로 최대 1400px 튀었고, 그게
 * "카메라가 한 번에 훅 간다"의 1차 원인이었다. v2는 만들 때부터 배치에 넣고,
 * 태그를 모르는 동안은 분류 없는 열에 둔다 — 태그가 확정되면 열 하나만큼만
 * 움직이고 그마저 스프링이 부드럽게 옮긴다.
 *
 * ## 저장은 완료 시 한 번
 *
 * 스트리밍 중 매 토큰마다 PATCH를 보내면 한 턴에 수백 번 왕복한다. `done`에서
 * 일괄 POST한다. 저장이 실패해도 화면의 아이템은 남는다 —
 * "RAG는 채팅을 절대 막지 않는다"와 같은 정신이다.
 */

import { useCallback, useRef, useState } from "react";
import { createItems, type NewItemInput } from "@/lib/api/canvas";
import { streamChat } from "@/lib/api/chat";
import type { ChatDoneEvent } from "@/lib/types";
import type { CanvasItem } from "./types";
import { appendLine, createStreamParser } from "./streamParser";

/** 도구 호출을 학생 말로 옮긴다. v1 TOOL_LABELS 이식. */
const TOOL_LABELS: Record<string, string> = {
  search_class_material: "수업 자료를 찾아보고 있어요…",
  search_textbook_figure: "교과서 그림을 찾아보고 있어요…",
  list_session_concepts: "지금까지 배운 걸 정리하고 있어요…",
  get_concept: "앞에서 나온 개념을 다시 보고 있어요…",
  list_session_files: "올린 파일을 확인하고 있어요…",
  read_session_file: "파일을 읽고 있어요…",
  think: "생각을 정리하고 있어요…",
};

export interface CanvasStreamApi {
  /** 말풍선 문구(스트리밍 중 진행 상황 포함). */
  reply: string;
  busy: boolean;
  /** 질문을 보낸다. parentItemId가 있으면 응답이 그 아이템의 자식이 된다. */
  send: (question: string, opts?: { parentItemId?: string | null }) => Promise<void>;
  /** 마지막 오류. */
  error: string | null;
}

interface Deps {
  sessionId: string | null;
  /** 로컬 아이템 목록에 반영한다. */
  upsertLocal: (items: CanvasItem[]) => void;
  /** 저장된 아이템으로 로컬을 갈아 끼운다(임시 id → 서버 id). */
  onPersisted: (tempIds: string[], saved: CanvasItem[]) => void;
  /** 현재 아이템 수 — seq를 이어 붙이는 데 쓴다. */
  nextSeq: () => number;
}

let tempCounter = 0;
const tempId = () => `tmp-${++tempCounter}`;

export function useCanvasStream({
  sessionId,
  upsertLocal,
  onPersisted,
  nextSeq,
}: Deps): CanvasStreamApi {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (question: string, opts?: { parentItemId?: string | null }) => {
      const q = question.trim();
      if (!q || !sessionId || busy) return;

      setBusy(true);
      setError(null);
      setReply("");

      const parentItemId = opts?.parentItemId ?? null;
      const baseSeq = nextSeq();
      // 이 턴에서 만든 아이템들. temp id로 먼저 그리고 done에서 서버 id로 바꾼다.
      const made: CanvasItem[] = [];
      let current: CanvasItem | null = null;

      const flush = () => {
        if (made.length) upsertLocal([...made]);
      };

      const parser = createStreamParser((ev) => {
        switch (ev.t) {
          case "reply":
            setReply(ev.text);
            break;
          case "cstart": {
            current = {
              id: tempId(),
              sessionId,
              nodeId: null,
              parentItemId,
              kind: "concept",
              source: "ai",
              title: ev.title || null,
              body: "",
              tag: ev.tag || null,
              x: 0,
              y: 0,
              pinned: false,
              seq: baseSeq + made.length,
              data: {},
              _pending: true,
            };
            made.push(current);
            flush();
            break;
          }
          case "body":
            if (current) {
              current.body = appendLine(current.body, ev.text);
              flush();
            }
            break;
          case "cend":
            current = null;
            break;
          case "done":
            break;
          case "related":
            break;
        }
      });

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let nodeId: string | null = null;

      try {
        await streamChat(
          { session_id: sessionId, question: q },
          {
            onToken: (delta) => parser.push(delta),
            onToolCall: (name) => setReply(TOOL_LABELS[name] ?? "찾아보고 있어요…"),
            onDone: (d: ChatDoneEvent) => {
              nodeId = d.node?.id ?? null;
              // 교과서 도판(D86~D95) — 서버가 done에 실어 보낸다. url은 signed라
              // 만료되므로 **저장하지 않는다**(D87). figureId만 남기고 화면에서
              // 필요할 때 재발급한다.
              for (const f of d.figures ?? []) {
                if (made.some((m) => m.data.figure?.figureId === f.figure_id)) continue;
                made.push({
                  id: tempId(),
                  sessionId,
                  nodeId: null,
                  parentItemId,
                  kind: "figure",
                  source: "ai",
                  title: null,
                  body: "",
                  tag: null,
                  x: 0,
                  y: 0,
                  pinned: false,
                  seq: baseSeq + made.length,
                  data: {
                    figure: {
                      figureId: f.figure_id,
                      fileId: f.file_id,
                      page: f.page ?? 0,
                      caption: f.caption ?? "",
                      url: f.url ?? "",
                    },
                  },
                });
              }
            },
            onError: (msg) => setError(msg),
          },
          ctrl.signal,
        );
      } catch (e) {
        setError((e as Error).message);
      }

      parser.end();
      // pending 해제 — 캐럿을 끄고 정상 아이템으로 만든다.
      for (const it of made) {
        it._pending = false;
        it.nodeId = nodeId;
      }
      flush();
      setBusy(false);

      if (!made.length) return;

      // 완료 시 한 번에 저장한다(스트리밍 중 매 토큰 PATCH는 수백 왕복이 된다).
      const payload: NewItemInput[] = made.map((it) => ({
        kind: it.kind,
        source: it.source,
        node_id: it.nodeId,
        parent_item_id: it.parentItemId,
        title: it.title,
        body: it.body,
        tag: it.tag,
        x: it.x,
        y: it.y,
        pinned: false,
        seq: it.seq,
        // 도판은 data에 메타가 있다. url은 빼고 보낸다(만료되는 값).
        data:
          it.kind === "figure" && it.data.figure
            ? { figure: { ...it.data.figure, url: "" } }
            : {},
      }));
      try {
        const saved = await createItems(sessionId, payload);
        onPersisted(
          made.map((i) => i.id),
          saved,
        );
      } catch (e) {
        // 저장 실패가 학습을 막지 않는다. 화면의 아이템은 그대로 두고 알린다.
        setError(`저장하지 못했습니다 — ${(e as Error).message}`);
      }
    },
    [sessionId, busy, upsertLocal, onPersisted, nextSeq],
  );

  return { reply, busy, send, error };
}
