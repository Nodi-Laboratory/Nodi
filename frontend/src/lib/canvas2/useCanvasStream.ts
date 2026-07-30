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
import { isRealId } from "@/lib/ids";
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
  /**
   * 카메라가 따라가야 할 아이템 id.
   *
   * 답이 어디에 생기는지 안 보이면 학생은 화면 밖에서 글이 생기는 것을 놓친다
   * (사용자가 지적한 "답변 생성 위치로 이동하는 기능"). 배치가 좌표를 정한 뒤
   * 상위가 이 id를 보고 스프링으로 옮긴다 — 여기서 카메라를 직접 만지지
   * 않는 이유는, 스트림은 좌표를 모르기 때문이다(배치 엔진이 소유한다).
   */
  focusId: string | null;
  /** 추종을 소비했다고 알린다. 같은 아이템으로 계속 끌려가지 않게. */
  clearFocus: () => void;
}

interface Deps {
  sessionId: string | null;
  /** 로컬 아이템 목록에 반영한다. */
  upsertLocal: (items: CanvasItem[]) => void;
  /** 저장된 아이템으로 로컬을 갈아 끼운다(임시 id → 서버 id). */
  onPersisted: (tempIds: string[], saved: CanvasItem[]) => void;
  /** 현재 아이템 수 — seq를 이어 붙이는 데 쓴다. */
  nextSeq: () => number;
  /** 이 도판이 이미 캔버스에 있나 (D95 세션 내 중복 제거). */
  hasFigure: (figureId: string) => boolean;
}

let tempCounter = 0;
const tempId = () => `tmp-${++tempCounter}`;

export function useCanvasStream({
  sessionId,
  upsertLocal,
  onPersisted,
  nextSeq,
  hasFigure,
}: Deps): CanvasStreamApi {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (question: string, opts?: { parentItemId?: string | null }) => {
      const q = question.trim();
      if (!q || !sessionId || busy) return;

      setBusy(true);
      setError(null);
      setReply("");

      const baseSeq = nextSeq();
      // 이 턴에서 만든 아이템들. temp id로 먼저 그리고 done에서 서버 id로 바꾼다.
      const made: CanvasItem[] = [];
      let current: CanvasItem | null = null;

      /**
       * 질문을 캔버스에 남긴다 — **"AI 응답이 연결되지 않는다"의 근본 원인**.
       *
       * 지금까지 연결선이 그려지는 유일한 경로는 "AI에게 묻기"였다. 입력창에
       * 그냥 물으면 부모가 없었고, 질문 자체도 캔버스에 남지 않아 **연결할
       * 대상이 아예 없었다.** 학생 화면에는 답만 덩그러니 생기고 무엇을 물었는지
       * 알 수 없었다.
       *
       * 이제 질문이 학생 글(kind='note')로 남고 그 턴의 모든 응답·도판이 그
       * 자식이 된다. 배치(layout.ts)가 자식을 부모 오른쪽에 두고 연결선이
       * 자동으로 따라온다.
       */
      const askedFrom = opts?.parentItemId ?? null;
      const questionItem: CanvasItem | null = askedFrom
        ? null // "AI에게 묻기" — 이미 있는 메모가 부모다
        : {
            id: tempId(),
            sessionId,
            nodeId: null,
            parentItemId: null,
            kind: "note",
            source: "user",
            title: null,
            body: q,
            tag: null,
            x: 0,
            y: 0,
            pinned: false,
            seq: baseSeq,
            data: { askHidden: true }, // 이미 물어본 글이다 — 버튼을 또 띄우지 않는다
          };
      if (questionItem) {
        made.push(questionItem);
        upsertLocal([questionItem]);
      }
      const parentItemId = askedFrom ?? questionItem?.id ?? null;

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
            // 첫 **개념**이 생기는 순간 카메라를 그쪽으로 보낸다(질문 아이템은
            // 세지 않는다). 두 번째부터는 옮기지 않는다 — 글이 하나씩 나올
            // 때마다 화면이 튀면 읽을 수 없다.
            if (made.filter((m) => m.kind === "concept").length === 1) {
              setFocusId(current.id);
            }
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
                // D95: **세션 내** 중복 제거. 이 턴(made)만 보면 앞 턴에서 이미
                // 나온 같은 도판이 다시 쌓인다 — 같은 그림이 캔버스에 여러 번
                // 뜬다. 화면에 있는 전체를 본다.
                if (hasFigure(f.figure_id) || made.some((m) => m.data.figure?.figureId === f.figure_id)) {
                  continue;
                }
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
        // 질문 아이템은 우리가 만든 것이라 노드에 속하지 않는다.
        if (it.kind === "concept" || it.kind === "figure") it.nodeId = nodeId;
      }
      flush();
      setBusy(false);

      if (!made.length) return;

      // 완료 시 한 번에 저장한다(스트리밍 중 매 토큰 PATCH는 수백 왕복이 된다).
      const payload: NewItemInput[] = made.map((it) => ({
        kind: it.kind,
        source: it.source,
        node_id: it.nodeId,
        // **서버에 있는 id만 보낸다.** 학생이 메모를 쓰고 blur 전에 바로
        // "AI에게 묻기"를 누르면 그 메모는 아직 로컬 전용(local-note-…)이다.
        // 그대로 보내면 FK 위반으로 **배치 전체가 실패**해 응답이 하나도
        // 저장되지 않는다 — 화면에는 있는데 새로고침하면 사라진다.
        // 연결선은 로컬 관계만으로도 그려지므로 화면은 정상이다.
        parent_item_id: isRealId(it.parentItemId) ? it.parentItemId : null,
        // 질문 아이템은 학생이 옮길 일이 많다 — 배치가 자리를 정하게 둔다.
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
        const tempIds = made.map((i) => i.id);
        onPersisted(tempIds, saved);
        // 임시 id가 서버 id로 바뀌면 추종 대상도 갱신해야 한다 —
        // 안 하면 사라진 id를 쫓다가 조용히 실패한다.
        setFocusId((cur) => {
          if (!cur) return cur;
          const at = tempIds.indexOf(cur);
          return at >= 0 && saved[at] ? saved[at].id : cur;
        });
      } catch (e) {
        // 저장 실패가 학습을 막지 않는다. 화면의 아이템은 그대로 두고 알린다.
        setError(`저장하지 못했습니다 — ${(e as Error).message}`);
      }
    },
    [sessionId, busy, upsertLocal, onPersisted, nextSeq, hasFigure],
  );

  const clearFocus = useCallback(() => setFocusId(null), []);

  return { reply, busy, send, error, focusId, clearFocus };
}
