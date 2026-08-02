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
import { createItems, patchItem, type NewItemInput } from "@/lib/api/canvas";
import { assignParents } from "./tree";
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
  /**
   * 질문을 보낸다.
   *
   * `pickedId`는 학생이 고른 트리 노드다 (D151). 답이 그 노드에서 갈라져
   * 나오고, 서버 프롬프트에도 "지금 이 트리를 보고 있다"로 실린다. 답의
   * 실제 부모는 **태그가 정한다** — 고른 노드와 답의 분류가 다르면 답은
   * 자기 태그의 트리로 간다(tree.ts `assignParents`).
   */
  send: (
    question: string,
    opts?: { pickedId?: string | null },
  ) => Promise<{ id: string; tag: string | null }[]>;
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
  /**
   * 지금 캔버스에 있는 것들 — 새 카드의 부모를 정하는 데 필요하다 (D151).
   *
   * 값이 아니라 **함수**로 받는다. 배열로 받으면 아이템이 하나 늘 때마다
   * `send`의 신원이 바뀌고, 스트리밍 중에 그 일이 계속 일어난다.
   */
  getItems: () => readonly CanvasItem[];
  /** 로컬 아이템 목록에 반영한다. */
  upsertLocal: (items: CanvasItem[]) => void;
  /** 저장된 아이템으로 로컬을 갈아 끼운다(임시 id → 서버 id). */
  onPersisted: (tempIds: string[], saved: CanvasItem[]) => void;
  /** 현재 아이템 수 — seq를 이어 붙이는 데 쓴다. */
  nextSeq: () => number;
  /** 이 도판이 이미 캔버스에 있나 (D95 세션 내 중복 제거). */
  hasFigure: (figureId: string) => boolean;
  /** 세션이 서버에서 사라졌다(404). 호출부가 다시 고르게 한다 (D153). */
  onSessionGone: () => void;
}

let tempCounter = 0;
const tempId = () => `tmp-${++tempCounter}`;

/**
 * 아이템 하나를 저장 요청 형태로.
 *
 * `parent_item_id`는 **서버에 있는 id만 보낸다.** 학생이 메모를 쓰고 blur 전에
 * 바로 "AI에게 묻기"를 누르면 그 메모는 아직 로컬 전용(local-note-…)이다.
 * 그대로 보내면 FK 위반으로 **배치 전체가 실패**해 응답이 하나도 저장되지
 * 않는다 — 화면에는 있는데 새로고침하면 사라진다. 연결선은 로컬 관계만으로도
 * 그려지므로 그 경우에도 화면은 정상이다.
 */
function toPayload(it: CanvasItem): NewItemInput {
  return {
    kind: it.kind,
    source: it.source,
    node_id: it.nodeId,
    parent_item_id: isRealId(it.parentItemId) ? it.parentItemId : null,
    title: it.title,
    body: it.body,
    tag: it.tag,
    // 배치가 자리를 정하게 둔다 — 학생이 옮기면 그때 pinned가 된다.
    x: it.x,
    y: it.y,
    pinned: false,
    seq: it.seq,
    // 도판은 data에 메타가 있다. url은 빼고 보낸다(만료되는 값, D87).
    // 그 외에는 렌더 힌트만 남긴다.
    data:
      it.kind === "figure" && it.data.figure
        ? { figure: { ...it.data.figure, url: "" } }
        : {
            ...(it.data.askedQuestion ? { askedQuestion: it.data.askedQuestion } : {}),
            ...(it.data.reflowDismissed ? { reflowDismissed: true } : {}),
          },
  };
}

export function useCanvasStream({
  sessionId,
  getItems,
  upsertLocal,
  onPersisted,
  nextSeq,
  hasFigure,
  onSessionGone,
}: Deps): CanvasStreamApi {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (question: string, opts?: { pickedId?: string | null }) => {
      const q = question.trim();
      if (!q || !sessionId || busy) return [];

      setBusy(true);
      setError(null);
      setReply("");

      const baseSeq = nextSeq();
      // 이 턴에서 만든 아이템들. temp id로 먼저 그리고 done에서 서버 id로 바꾼다.
      const made: CanvasItem[] = [];
      let current: CanvasItem | null = null;

      /**
       * **연결선은 "AI에게 묻기"에서만 생긴다** (사용자 지시 2026-07-31).
       *
       * 한때 하단 입력창의 질문도 학생 글(kind='note')로 캔버스에 남기고 답을
       * 그 자식으로 달았다. 그러면 평범한 질문 한 번에 상자가 둘 생기고 캔버스가
       * 금세 어수선해진다. 부모-자식 관계는 **학생이 자기 글을 짚어 물었을 때**만
       * 의미가 있다 — 그때만 "이 글에 대한 답"이라는 관계가 실재한다.
       *
       * 대신 질문 원문은 답 아이템의 `data.askedQuestion`에 실어 둔다. 상자를
       * 하나 더 만들지 않으면서도 hover 툴팁이 "무엇을 물어본 답인지" 보여 줄 수
       * 있다(QuestionTip).
       */
      const picked = opts?.pickedId ?? null;
      /**
       * 학생이 친 질문은 **언제나** 답에 실어 둔다 (D149).
       *
       * 한때는 "AI에게 묻기"로 물었을 때만 뺐다 — 그때는 부모가 학생이 쓴
       * 질문 글이라 중복이었기 때문이다. 지금 답의 부모는 **같은 태그의 앞
       * 카드**라 질문이 아니다. 안 실으면 학생이 뭘 물었는지가 캔버스
       * 어디에도 남지 않는다.
       */
      const askedQuestion = q;

      /**
       * 이번 턴 카드의 부모를 정한다 (D151).
       *
       * 태그를 아는 순간(`cstart`)에 바로 정한다 — 나중에 몰아서 정하면
       * 스트리밍 중에는 부모 없는 상태로 그려지다가 끝나는 순간 선이 우르르
       * 생긴다. 지금 자리에서 자라나는 것처럼 보여야 한다.
       */
      const turnCards: { id: string; tag: string | null }[] = [];
      const parentFor = (id: string, tag: string | null): string | null => {
        turnCards.push({ id, tag });
        return assignParents(getItems(), turnCards, picked).get(id) ?? null;
      };

      const flush = () => {
        if (made.length) upsertLocal([...made]);
      };

      const parser = createStreamParser((ev) => {
        switch (ev.t) {
          case "reply":
            setReply(ev.text);
            break;
          case "cstart": {
            const id = tempId();
            current = {
              id,
              sessionId,
              nodeId: null,
              parentItemId: parentFor(id, ev.tag || null),
              kind: "concept",
              source: "ai",
              title: ev.title || null,
              body: "",
              tag: ev.tag || null,
              x: 0,
              y: 0,
              pinned: false,
              seq: baseSeq + made.length,
              // 질문 원문을 싣는다 — 상자를 하나 더 만들지 않고도 hover
              // 툴팁이 "무엇을 물어본 답인지" 보여 준다.
              data: { askedQuestion },
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
          {
            session_id: sessionId,
            question: q,
            // 고른 노드의 분류가 곧 "지금 보고 있는 트리"다 (D151).
            focus_tag: picked
              ? (getItems().find((i) => i.id === picked)?.tag ?? null)
              : null,
          },
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
                  // 도판은 트리 노드가 아니다 — 부모를 주면 배치가 옆에 붙인다.
                  parentItemId: null,
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
                    askedQuestion,
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
            onError: (msg, status) => {
              // 404는 "세션이 없다"는 뜻이다. 오류 문구만 띄우면 학생은 계속
              // 같은 죽은 세션에 질문한다 (D153).
              if (status === 404) {
                setError("대화가 사라져 새 대화를 엽니다.");
                onSessionGone();
                return;
              }
              setError(msg);
            },
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

      // 만들어진 카드를 돌려준다 — 호출부가 초점을 어디로 옮길지 정한다(D151).
      const created = () => made.map((m) => ({ id: m.id, tag: m.tag }));
      if (!made.length) return [];

      // 완료 시 한 번에 저장한다(스트리밍 중 매 토큰 PATCH는 수백 왕복이 된다).
      const payload: NewItemInput[] = made.map(toPayload);
      try {
        const saved = await createItems(sessionId, payload);
        const tempIds = made.map((i) => i.id);
        const realOf = new Map(tempIds.map((t, i) => [t, saved[i]?.id]));

        /**
         * 서버가 돌려준 행에 **우리가 아는 부모를 채워 넣는다** (D151).
         *
         * 같은 턴 안에서 이어 붙인 부모는 임시 id라 저장에 싣지 못했다(FK).
         * 그래서 서버 행의 `parentItemId`는 비어 있는데, 그 행으로 로컬을
         * 통째 교체하면 **화면에서 방금 그려진 선이 사라진다** — DB에는
         * 있는데 새로고침 전까지 안 보이는 상태가 된다(실측으로 잡았다:
         * 카드 셋이 전부 뿌리로 그려져 지도에 간선이 하나도 없었다).
         */
        const linked = saved.map((row, i) => {
          const p = made[i]?.parentItemId;
          if (!row || !p || isRealId(p)) return row;
          const real = realOf.get(p);
          return real ? { ...row, parentItemId: real } : row;
        });
        onPersisted(tempIds, linked);

        /**
         * 같은 턴 안에서 이어 붙인 부모를 서버에도 잇는다 (D151).
         *
         * `toPayload`는 임시 id를 부모로 보내지 않는다 — 아직 행이 없는
         * 것을 가리키면 FK 위반으로 **배치 전체가 실패**한다. 그래서 저장
         * 뒤에 진짜 id로 한 번 더 이어 준다. 화면에는 이미 이어져 있으므로
         * (replaceTemp가 부모 참조까지 옮긴다) 이 왕복이 늦어도 티가 나지
         * 않고, 실패해도 다음 새로고침에서 선 하나가 빠질 뿐 글은 남는다.
         */
        const relink = made
          .map((m, i) => {
            const p = m.parentItemId;
            const child = saved[i];
            if (!child || !p || isRealId(p)) return null;
            const real = realOf.get(p);
            return real ? patchItem(child.id, { parent_item_id: real }) : null;
          })
          .filter((v): v is NonNullable<typeof v> => !!v);
        if (relink.length) {
          await Promise.all(relink).catch((e: Error) =>
            setError(`연결을 저장하지 못했습니다 — ${e.message}`),
          );
        }
        // 임시 id가 서버 id로 바뀌면 추종 대상도 갱신해야 한다 —
        // 안 하면 사라진 id를 쫓다가 조용히 실패한다.
        setFocusId((cur) => {
          if (!cur) return cur;
          const at = tempIds.indexOf(cur);
          return at >= 0 && saved[at] ? saved[at].id : cur;
        });
        // 저장된 뒤에는 **서버 id**를 돌려준다. 임시 id를 넘기면 호출부가
        // 곧 사라질 id를 초점으로 잡는다.
        return made.map((m, i) => ({ id: saved[i]?.id ?? m.id, tag: m.tag }));
      } catch (e) {
        // 저장 실패가 학습을 막지 않는다. 화면의 아이템은 그대로 두고 알린다.
        setError(`저장하지 못했습니다 — ${(e as Error).message}`);
      }
      return created();
    },
    [sessionId, busy, getItems, upsertLocal, onPersisted, nextSeq, hasFigure, onSessionGone],
  );

  const clearFocus = useCallback(() => setFocusId(null), []);

  return { reply, busy, send, error, focusId, clearFocus };
}
