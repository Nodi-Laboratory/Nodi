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
import { useClientSettings } from "./useClientSettings";

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

/** 펜으로 그린 표시의 해석 (D178). 손으로 물었을 때만 실린다. */
export interface InkSendContext {
  /** "화살표가 [카드 2]를 가리킨다. [카드 1]은 닿지 않는다." */
  marksNote: string;
  /** 도식에 그려진 순서 그대로. **이 순서가 곧 `[카드 N]`의 N이다.** */
  cardIds: string[];
  /**
   * 기하가 센 **짚은 카드 번호**(1부터). 서버 프롬프트가 이걸 단정문으로 쓴다.
   *
   * 설명 산문만 보내고 SOLAR가 거기서 대상을 읽어 내기를 기대하면 자주 다른
   * 카드를 설명한다(사용자 보고 2026-08-05) — 우리가 아는 답은 우리 말로 준다.
   */
  pointed: number[];
  /**
   * 짚은 카드의 아이템 id — 이 턴의 트리 부모다(D178).
   *
   * 서버에는 안 보낸다. 부모 결정은 화면의 일이고(D151 `assignParents`),
   * 서버는 카드 본문만 다시 읽는다.
   */
  parentId: string | null;
}

export interface SendOpts {
  pickedId?: string | null;
  ink?: InkSendContext | null;
}

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
  /**
   * 질문을 보내고 **만들어진 아이템들**을 돌려준다.
   *
   * id·tag만 돌려주던 것을 아이템 전체로 넓혔다(D194). 호출부가 이 턴의
   * 카드로 **판단**을 해야 하는데(코치의 사슬 깊이), store는 아직 이 카드들을
   * 커밋하지 않았을 수 있다 — id만 받으면 store에서 되찾아야 하고 그 조회가
   * 빈손이면 **아무 일도 안 일어난 것처럼** 보인다(실측 2026-08-07: 말풍선이
   * 한 번도 안 떴다). 부모까지 이어진 실체를 그대로 넘긴다.
   */
  send: (question: string, opts?: SendOpts) => Promise<CanvasItem[]>;
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
  /** 이 클립이 이미 캔버스에 있나 (D149 세션 내 중복 제거). */
  hasClip: (clipId: string) => boolean;
  /** 세션이 서버에서 사라졌다(404). 호출부가 다시 고르게 한다 (D153). */
  onSessionGone: () => void;
  /**
   * 지금 보고 있는 자리 근처의 **빈 자리** n개 (D210 7-1 C).
   *
   * "이미지만 추천해줘"인데 고른 카드도 없으면 곁들이가 붙을 데가 없다.
   * 좌표와 크기는 배치 엔진이 소유하므로(스트림은 모른다) 호출부가 준다.
   */
  dropSpots: (count: number) => { x: number; y: number }[];
}

/**
 * 한 프레임에 내보낼 글자 수 (D162).
 *
 * 사용자 지적 2026-08-03: "텍스트가 생성되는 속도가 너무 빠르다." 모델은
 * 사람이 읽는 것보다 훨씬 빨리 뱉는다 — 받는 대로 그리면 글이 순식간에
 * 나타났다가 멈춰 있어서, 읽을 준비를 하기도 전에 끝난다.
 *
 * 60fps 기준 2자/프레임 ≈ 120자/초. 한국어 한 문단(약 120자)이 1초에 걸쳐
 * 흐른다.
 */
// D174: 이 값의 기본값은 `lib/api/clientSettings.ts`가 갖는다 —
// 서버를 못 부를 때 쓰는 fallback도 그쪽 한 곳에만 둔다.
/**
 * 스트림이 끝난 뒤 남은 글을 마저 내보낼 때의 상한 프레임 수.
 *
 * 없으면 모델이 길게 답한 턴에서 **다 받아 놓고도 몇십 초를 더 타이핑한다.**
 * 남은 길이를 이 프레임 수로 나눠 속도를 올린다(≈2초 안에 끝난다).
 */
const TAIL_FRAMES = 120;

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
    // 클립은 page_url이 안정적(EBS 공식 링크)이라 그대로 영속한다(D149) —
    // 도판처럼 지우지 않는다.
    // 그 외에는 렌더 힌트만 남긴다.
    data:
      it.kind === "figure" && it.data.figure
        ? { figure: { ...it.data.figure, url: "" } }
        : it.kind === "clip" && it.data.clip
          ? { clip: it.data.clip }
          : {
              ...(it.data.askedQuestion ? { askedQuestion: it.data.askedQuestion } : {}),
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
  hasClip,
  dropSpots,
  onSessionGone,
}: Deps): CanvasStreamApi {
  // D174: 글자 속도·한 턴 카드 수는 관리자가 정한다.
  const clientSettings = useClientSettings();
  const charsPerFrame = Math.max(1, clientSettings.typeCharsPerFrame);
  const cardsPerTurn = Math.max(1, clientSettings.cardsPerTurn);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (question: string, opts?: SendOpts) => {
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
       * 고른 트리가 있으면 **이번 턴의 분류를 그 트리로 고정한다** (D158).
       *
       * 사용자 지적 2026-08-03: "A트리에서 이어서 질문했는데 응답이 B트리에
       * 작성되는 경우가 생긴다." 모델이 내용상 더 맞는 새 분류를 지어내면
       * 그렇게 된다 — 분류만 보면 틀린 판단이 아니지만, **학생은 A에서
       * 물었으니 A에 붙기를 기대한다.** 고른 곳에 답이 안 붙으면 트리를
       * 고르는 행위 자체가 뜻을 잃는다.
       *
       * 프롬프트로 부탁하는 것(focus_tag)만으로는 보장이 안 된다 — 권유는
       * 지켜지지 않을 때가 있고, 어긋나면 학생이 그 사실을 알 방법도 없다.
       * 그래서 화면에 그리기 전에 여기서 못 박는다.
       *
       * 고른 것이 없으면 예전대로 모델의 분류를 따른다.
       */
      const pickedTag = picked
        ? (getItems().find((i) => i.id === picked)?.tag ?? null)
        : null;
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

      /**
       * 받은 전체 본문과 **화면에 내보낸 길이** (D162).
       *
       * 한 턴에 노드는 하나뿐이므로(아래 `cstart` 참조) 하나면 충분하다.
       * 받는 것과 보여 주는 것을 갈라 두면 속도를 우리가 정할 수 있다.
       */
      let target = "";
      let shown = 0;
      /**
       * 클립·도판이 딸린 카드 (D163). 턴이 끝난 뒤 카메라를 다시 부르는 데 쓴다.
       *
       * 카메라는 `cstart`에서 카드 하나만 보고 이미 235%로 날아갔다(D162).
       * 딸린 것은 `done`에 오므로, 다시 걸지 않으면 배치는 옆에 잘 붙여 놓고도
       * 화면은 카드만 꽉 채운 채 끝난다 — 학생 눈에는 추천이 없는 것과 같다.
       */
      let attachHost: string | null = null;
      let streamDone = false;
      let timer = 0;
      /** 본문을 받는 노드. `current`는 `cend`에서 비므로 여기에 매지 않는다. */
      const headItem = () => made.find((m) => m.kind === "concept");
      const tick = () => {
        const head = headItem();
        if (head && shown < target.length) {
          const left = target.length - shown;
          const per = streamDone
            ? Math.max(charsPerFrame, Math.ceil(left / TAIL_FRAMES))
            : charsPerFrame;
          shown = Math.min(target.length, shown + per);
          head.body = target.slice(0, shown);
          flush();
        }
      };
      /**
       * **`requestAnimationFrame`을 쓰지 않는다** (D162).
       *
       * rAF는 탭이 뒤에 있으면 아예 돌지 않는다. 학생이 답을 기다리는 동안
       * 다른 탭을 보면 글이 멈추는 정도가 아니라 **턴이 끝나지 않아 저장이
       * 통째로 안 된다**(실측으로 잡았다: 화면에 글이 있는데 DB는 0행).
       * 타이머는 배경에서 느려질 뿐 멈추지는 않는다.
       *
       * ⚠️ **그 말은 데스크톱 얘기다** (2026-08-10). iPadOS는 다른 앱으로
       * 가면 탭을 통째로 얼리고, 돌아오지 못한 채 정리하기도 한다 — 그때는
       * 타이머도 이 훅도 같이 죽어 카드 저장이 아예 안 일어난다. 여기서
       * 더 버틸 방법은 없다.
       *
       * **대신 서버가 노드를 따로 저장하고, 다시 들어올 때 카드 없는 답을
       * 고아로 주워 담는다** — 실측(2026-08-10): 스트리밍 도중 탭을 죽이고
       * 다시 들어가니 답이 카드로 돌아왔다. 그 복구가 패드의 안전망이니
       * 함부로 걷어내지 마라.
       */
      timer = window.setInterval(tick, 16);

      const parser = createStreamParser((ev) => {
        switch (ev.t) {
          case "reply":
            setReply(ev.text);
            break;
          case "cstart": {
            /**
             * **한 턴에 노드 하나** (D162, 사용자 지시 2026-08-03).
             *
             * 모델은 한 답에 개념 카드를 여러 장 쓸 때가 많다. 그대로 두면
             * 질문 한 번에 노드가 셋씩 생겨 트리가 순식간에 불어난다.
             *
             * 두 번째부터는 **버리지 않고 이어 쓴다** — 제목을 굵은 줄로
             * 남기고 본문을 뒤에 붙인다. 내용을 잘라 내면 학생이 받은 답의
             * 일부가 사라지는데, 그건 "노드 하나"보다 나쁜 결과다.
             */
            /**
             * D174: 상한이 **1로 고정**이었다(D162). 이제 관리자가 정한다 —
             * 상한에 닿았으면 새 카드를 만들지 않고 마지막 카드에 이어 붙인다.
             */
            const concepts = made.filter((m) => m.kind === "concept");
            const already =
              concepts.length >= cardsPerTurn
                ? concepts[concepts.length - 1]
                : undefined;
            if (already) {
              current = already;
              if (ev.title) target = appendLine(target, `**${ev.title}**`);
              break;
            }
            const id = tempId();
            const tag = pickedTag ?? ev.tag ?? null;
            current = {
              id,
              sessionId,
              nodeId: null,
              parentItemId: parentFor(id, tag),
              kind: "concept",
              source: "ai",
              title: ev.title || null,
              body: "",
              tag,
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
            // 화면에는 `tick`이 조금씩 내보낸다 — 여기서는 받아 두기만 한다.
            if (current) target = appendLine(target, ev.text);
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
            // D178: 펜으로 물었을 때만. 표시 설명이 비었으면 보낼 것이 없다.
            ink:
              opts?.ink && opts.ink.cardIds.length
                ? {
                    marks_note: opts.ink.marksNote,
                    card_ids: opts.ink.cardIds,
                    pointed: opts.ink.pointed,
                  }
                : null,
          },
          {
            onToken: (delta) => parser.push(delta),
            onToolCall: (name) => setReply(TOOL_LABELS[name] ?? "찾아보고 있어요…"),
            onDone: (d: ChatDoneEvent) => {
              nodeId = d.node?.id ?? null;
              /**
               * 이번 턴의 개념 카드 — 클립·도판이 **딸릴 카드**다 (D163).
               *
               * 예전에는 둘 다 `parentItemId=null`이라 태그 없는 열(UNTAGGED)로
               * 갔다. 그 열은 태그 열들 **뒤**에 붙으므로 카드에서 최소
               * COL_GAP(760)만큼 떨어지는데, 새 노드를 235%로 당겨 보는
               * 흐름(D162)에서는 화면 밖이다 — 검색은 됐는데 학생 눈에는
               * 아무것도 안 뜬 것과 같았다.
               *
               * 부모를 주면 배치가 카드 오른쪽에 붙인다(layout 3)). 태그도
               * 물려받는다 — 카드가 지워졌을 때 같은 열로 떨어지라고.
               */
              /**
               * 개념 카드가 없는 턴도 있다 (D210 7-1 B·C) — "이미지만 추천해줘".
               * 그때는 학생이 **고른 카드**에 딸린다(B). 고른 것도 없으면(C)
               * 화면 가운데의 빈 자리를 받는다.
               */
              const 고른것 = opts?.pickedId
                ? (getItems().find((i) => i.id === opts.pickedId) ?? null)
                : null;
              const host = made.find((m) => m.kind === "concept") ?? 고른것 ?? undefined;
              /**
               * 자리는 **미리** 다 받아 둔다. 하나씩 요청하면 앞서 만든 것이
               * 아직 배치에 안 들어가 같은 칸이 두 번 나온다.
               */
              const 놓을수 = host ? 0 : (d.figures?.length ?? 0) + (d.clips?.length ?? 0);
              const 빈자리 = 놓을수 ? dropSpots(놓을수) : [];
              let 자리번호 = 0;
              /** 딸릴 데가 없으면 좌표를 직접 준다 — `pinned`라 배치가 안 끌어간다. */
              const 자리 = () => {
                if (host) return { x: 0, y: 0, pinned: false };
                const at = 빈자리[자리번호++] ?? { x: 0, y: 0 };
                return { x: at.x, y: at.y, pinned: true };
              };
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
                  // 도판은 트리 노드가 아니다(tree.ts) — 부모를 줘도 간선이
                  // 생기지 않고, 배치만 카드 옆으로 붙는다 (D163).
                  parentItemId: host?.id ?? null,
                  kind: "figure",
                  source: "ai",
                  title: null,
                  body: "",
                  tag: host?.tag ?? null,
                  ...자리(),
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
              // 강의 클립(D149) — 서버가 done에 실어 보낸다. page_url은
              // 안정적이라 그대로 영속한다(도판과 달리 재발급 불필요).
              for (const c of d.clips ?? []) {
                // D149: 도판과 같은 세션 내 중복 제거 — 앞 턴에서 나온 같은
                // 클립이 다시 쌓이지 않게 화면 전체를 본다.
                if (hasClip(c.clip_id) || made.some((m) => m.data.clip?.clipId === c.clip_id)) {
                  continue;
                }
                made.push({
                  id: tempId(),
                  sessionId,
                  nodeId: null,
                  // 클립도 트리 노드가 아니다 — 도판과 같이 카드에 딸린다 (D163).
                  parentItemId: host?.id ?? null,
                  kind: "clip",
                  source: "ai",
                  title: null,
                  body: "",
                  tag: host?.tag ?? null,
                  ...자리(),
                  seq: baseSeq + made.length,
                  data: {
                    ...(askedQuestion ? { askedQuestion } : {}),
                    clip: {
                      clipId: c.clip_id,
                      title: c.title,
                      startSec: c.start_sec,
                      timelineLabel: c.timeline_label,
                      pageUrl: c.page_url,
                      videoTitle: c.video_title ?? "",
                      score: c.score,
                    },
                  },
                });
              }
              // 딸린 것이 생겼다 — 턴이 끝나고 화면에 올라간 **뒤에** 초점을
              // 다시 준다(아래). 여기서 바로 걸면 store에 아직 없어서 카메라가
              // 카드 하나만 보고 날아간다.
              if (host && made.some((m) => m.kind === "clip" || m.kind === "figure")) {
                attachHost = host.id;
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
      streamDone = true;
      /**
       * **다 내보낸 뒤에 마무리한다.**
       *
       * 여기서 바로 저장하면 화면에는 아직 절반만 쓰인 글이 남아 있는데
       * 서버에는 전문이 들어간다 — 새로고침하면 글이 갑자기 길어진다.
       */
      // 안전망: 어떤 이유로든 드레인이 멈춰도 턴은 끝나야 한다. 여기서 걸리면
      // 저장이 통째로 안 되고 입력창이 영영 잠긴다.
      await new Promise<void>((resolve) => {
        const t0 = Date.now();
        const check = window.setInterval(() => {
          if (shown >= target.length || Date.now() - t0 > 8000) {
            window.clearInterval(check);
            resolve();
          }
        }, 30);
      });
      window.clearInterval(timer);
      // 마지막 한 글자까지 맞춘다(반올림으로 뒤가 잘리는 일이 없게).
      const head = headItem();
      if (head) head.body = target;

      // pending 해제 — 캐럿을 끄고 정상 아이템으로 만든다.
      for (const it of made) {
        it._pending = false;
        // 질문 아이템은 우리가 만든 것이라 노드에 속하지 않는다.
        if (it.kind === "concept" || it.kind === "figure" || it.kind === "clip")
          it.nodeId = nodeId;
      }
      flush();
      setBusy(false);
      // 이제서야 클립·도판이 화면에 있다. 초점을 다시 주면 호출부가 묶음이
      // 다 들어오는 배율로 맞춘다(focusCamera, D163).
      if (attachHost) setFocusId(attachHost);

      // 만들어진 카드를 돌려준다 — 호출부가 초점을 어디로 옮길지 정한다(D151).
      const created = () => made;
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
          if (!row) return row;
          let next = row;

          /**
           * 방금 받은 signed URL을 서버 행에 되돌려 놓는다 (D167).
           *
           * url은 만료되므로 저장하지 않는다(D87 — `toPayload`가 지운다).
           * 그래서 서버 행에는 주소가 없고, 그 행으로 로컬을 갈아끼우면
           * **살아 있던 이미지가 스켈레톤으로 되돌아간다**(실측: 생성 1.3초
           * 뒤 사라졌다). 저장 안 하는 것과 화면에서 지우는 것은 다르다 —
           * 손에 있는 주소는 그대로 쓴다.
           *
           * 이게 없어도 FigureItem이 다시 받아 오지만(D167), 방금 받은 것을
           * 버리고 다시 묻는 왕복 + 그동안의 깜빡임은 그냥 손해다.
           */
          const liveUrl = made[i]?.data.figure?.url;
          if (next.kind === "figure" && liveUrl && !next.data.figure?.url) {
            next = {
              ...next,
              data: { ...next.data, figure: { ...next.data.figure!, url: liveUrl } },
            };
          }

          const p = made[i]?.parentItemId;
          if (!p || isRealId(p)) return next;
          const real = realOf.get(p);
          return real ? { ...next, parentItemId: real } : next;
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
        // 저장된 뒤에는 **서버 행**을 돌려준다. 임시 id를 넘기면 호출부가
        // 곧 사라질 id를 초점으로 잡는다. `linked`는 같은 턴의 부모까지 진짜
        // id로 이어 놓은 것이라, 받는 쪽이 사슬을 그대로 탈 수 있다(D194).
        return made.map((m, i) => linked[i] ?? { ...m, id: saved[i]?.id ?? m.id });
      } catch (e) {
        // 저장 실패가 학습을 막지 않는다. 화면의 아이템은 그대로 두고 알린다.
        setError(`저장하지 못했습니다 — ${(e as Error).message}`);
      }
      return created();
    },
    [
      sessionId, busy, getItems, upsertLocal, onPersisted, nextSeq,
      hasFigure, hasClip, onSessionGone, dropSpots,
      // D174: 관리자가 바꾸면 다음 턴부터 새 값으로 돈다.
      charsPerFrame, cardsPerTurn,
    ],
  );

  const clearFocus = useCallback(() => setFocusId(null), []);

  return { reply, busy, send, error, focusId, clearFocus };
}
